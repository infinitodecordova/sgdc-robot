// Revisión de los turnos cerrados contra el SGDC (corre con el robot del SGDC, después del cierre
// automático y la corrección).
//
// Cuando el Power BI del SGDC ya cubre el final de un turno cerrado (por una persona o por el robot),
// compara la foto del turno con las cargas del SGDC de esa ventana y avisa al admin en ERRORES si:
//   1. Un bus quedó anotado como cargado (pistola o % que sube) y el SGDC no tiene ninguna carga suya.
//   2. Un bus quedó "BUS NO INGRESADO A CARGA" (NI) pero con pistola o % que sube.
//   3. El SGDC tiene una carga de un bus que en el turno no quedó anotada (sin pistola ni % final, o marcado
//      sin carga NI / motivo y sin pistola).
//   4. El SGDC tiene una carga de un bus que no está en la foto del turno ni en otros terminales.
//   5. El SGDC tiene un bus cargando en dos pistolas a la vez (patente mal digitada en el cargador). Si en
//      esa pistola hay un bus anotado sin carga a su nombre, se dice que la carga es probablemente suya.
//   6. Un bus anotado con pistola en la que el SGDC no lo tiene, o con un % final que difiere en más de
//      2 puntos del de su última carga finalizada en el SGDC (p. ej. el 100 % falso del patio).
//      No se revisa el % de las cargas cortadas por una caída del SGDC (ver `cortesSgdc`).
// Los buses que la app marcó `sinPatio` (carga anotada con el patio sin datos en vivo) no se acusan por
// faltar en el SGDC ni por el % final: esas cargas no quedan en el sistema. Se listan aparte, como dato.
// Con los cargadores (Dhemax, dhemax_cruce.mjs) como árbitro, si hay DHEMAX_USUARIO/DHEMAX_CLAVE:
//   - Una carga que el SGDC no tiene pero el cargador sí (misma pistola, % inicial parecido o patente del
//     SGDC) queda confirmada: solo se avisa si el % final anotado no calza con el del cargador.
//   - Si el SGDC y el bombero no coinciden, manda el cargador (el SGDC se corta o parte tarde).
//   - 7. El cargador hizo una carga que nadie anotó y que el SGDC tampoco tiene.
//   - Si el SGDC no cubre el turno después de ESPERA_SGDC_H, se revisa solo con los cargadores.
//   - El cruce se guarda en dhemaxTurnos/<id del turno> (lo usa la app en "Cargas sin SGDC").
//   Si Dhemax no responde, se revisa como antes, solo con el SGDC.
// Cada turno se revisa una sola vez (candado en privado/revision_<id del turno>).
// No cambia lo anotado: solo avisa y deja el resultado en turnos/<id>.verificacion (lo muestra el historial). Lecturas: ~3 turnos + ~6 candados por pasada y, una vez por
// turno, sus cargas del SGDC (~40–80).

import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { chile, reasignarReservas } from './auto_correccion.mjs';
import { ventana } from './cierre_automatico.mjs';
import { correccionDe } from './propuestas.mjs';
import { calzaFinal, cargasDhemaxEntre, emparejar, finalDudoso, hayDhemax, paraFirestore, PISTOLAS, textoCarga } from './dhemax_cruce.mjs';

// Sin hora de cierre (no pasa con turnos cerrados): el SGDC tiene que llegar 20 min después del fin de la ventana.
const MARGEN_FIN_MIN = 20;
// Solo turnos cerrados en las últimas 36 h (después de eso ya no se espera más al SGDC).
const VENTANA_H = 36;
// Si el SGDC no cubre el turno después de estas horas, se revisa solo con los cargadores (Dhemax).
const ESPERA_SGDC_H = 4;
// El cruce con los cargadores se guarda (dhemaxTurnos) cuando el turno terminó hace al menos esto.
const ESPERA_DHEMAX_MIN = 30;
const DHEMAX_REINTENTO_H = 4; // si Dhemax falla o viene vacío para un turno, no se vuelve a pedir antes de esto
const SUBE = 2; // puntos: % final que supera al inicial en más que esto = se anotó como cargado
const TOLERANCIA = 2; // puntos: diferencia aceptada entre el % final anotado y el del SGDC
const CORTA_PCT = 2; // carga del SGDC sin anotar que sube esto o menos: no cuenta como problema

const norma = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const aFecha = (x) => x?.toDate?.() ?? x ?? null;
const nombre = (t) => (t === 'PM' ? 'nocturno' : 'diurno');
const hm = (d) => {
  const h = chile(d).hm;
  return `${String(Math.floor(h / 100)).padStart(2, '0')}:${String(h % 100).padStart(2, '0')}`;
};
const pct = (a, b) => `${a ?? '—'}→${b ?? '—'}`;
// Fin de una carga: el del SGDC, o inicio + minutos, o (en proceso, sin datos) inicio + 3 h.
// Caída del SGDC: si deja de recibir datos, todas las cargas en curso quedan "Finalizada" a la misma
// hora con el % que tenían (20-11 01:56–01:59: 14 cargas entre 59 y 96 %). Se reconoce porque
// CORTE_MIN o más cargas terminan bajo 100 % dentro de CORTE_VENTANA_MIN minutos.
const CORTE_MIN = 5;
const CORTE_VENTANA_MIN = 5;
const finDe = (c) => aFecha(c.fin) ??
  new Date(c.inicio.getTime() + (c.minutos ? c.minutos * 60000 : 3 * 3600 * 1000));

/// Cargas cortadas por una caída del SGDC (Set) y la hora de cada corte (lista de Date).
export function cortesSgdc(cargas) {
  const bajo = cargas
    .filter((c) => c.estado === 'Finalizada' && c.fin && c.socFin != null && c.socFin < 100)
    .sort((a, b) => aFecha(a.fin) - aFecha(b.fin));
  const cortadas = new Set();
  const horas = [];
  for (let i = 0; i < bajo.length; i++) {
    const t0 = aFecha(bajo[i].fin).getTime();
    let j = i;
    while (j + 1 < bajo.length && aFecha(bajo[j + 1].fin).getTime() - t0 <= CORTE_VENTANA_MIN * 60000) j++;
    if (j - i + 1 >= CORTE_MIN) {
      for (let k = i; k <= j; k++) cortadas.add(bajo[k]);
      horas.push(aFecha(bajo[j].fin));
      i = j;
    }
  }
  return { cortadas, horas };
}

/// Problemas de un turno (lista de textos). Exportada para probarla sin Firestore.
/// [sugerencias]: se le agregan las patentes mal digitadas que la app puede corregir con un toque
/// ({ pistola, de, a, inicio, kwh, soh, socInicio, socFin }).
/**
 * @param dh cruce con los cargadores (emparejar() de dhemax_cruce.mjs) o null si Dhemax no está disponible.
 * @param info se llena con { correcciones: [...] } (pistola o % final que se puede corregir sin duda, ver
 *   `correccionDe`; las aplica el admin desde el Historial; el problema se cuenta igual), { confirmadas: [ppu] } (cargas que el SGDC no tenía y el cargador sí, bien anotadas) y
 *   { erroresSgdc: [texto] } (patente mal digitada en el cargador: lo anotado está bien, no cuenta como problema).
 */
export function problemasTurno(t, cargas, sugerencias = [], sinPatio = [], dh = null, info = {}) {
  info.confirmadas ??= [];
  info.correcciones ??= [];
  info.erroresSgdc ??= [];
  info.cortas ??= [];
  const porBus = new Map();
  for (const c of cargas) {
    const p = norma(c.ppu);
    if (!porBus.has(p)) porBus.set(p, []);
    porBus.get(p).push(c);
  }
  // Errores de reserva anotados: la carga del SGDC a nombre de otra patente es del bus que la anotó.
  reasignarReservas(t.buses ?? [], porBus);
  for (const l of porBus.values()) l.sort((x, y) => (x.inicio ?? x.reserva ?? 0) - (y.inicio ?? y.reserva ?? 0));

  // Un bus no puede cargar en dos pistolas a la vez: si el SGDC lo tiene así, una de esas cargas es de
  // otro bus (patente mal digitada en el cargador).
  const dobles = []; // { ppu, c (la carga), otra (la que se le cruza) }
  for (const [ppu, l] of porBus) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const a = l[i];
        const b = l[j];
        if (!a.inicio || !b.inicio || a.pistola === b.pistola) continue;
        // Carga cortada (quedó "En proceso", sus datos no son confiables) y seguida en otra pistola: no es doble.
        if (a.estado !== 'Finalizada') continue;
        if (b.inicio < finDe(a)) {
          dobles.push({ ppu, c: a, otra: b }, { ppu, c: b, otra: a });
        }
      }
    }
  }
  const { cortadas } = cortesSgdc(cargas);
  const explicadas = new Set(); // cargas dobles que calzan con un bus anotado sin carga

  const out = [];
  const enFoto = new Set();
  for (const b of t.buses ?? []) {
    const ppu = norma(b.ppu ?? b.id);
    enFoto.add(ppu);
    const l = porBus.get(ppu) ?? [];
    const conPistola = PISTOLAS.has(b.coordenada);
    const sube = b.pctInicial != null && b.pctFinal != null && b.pctFinal > b.pctInicial + SUBE;
    const anotadoCargado = conPistola || sube;
    const como = `${conPistola ? `${b.coordenada}, ` : ''}${pct(b.pctInicial, b.pctFinal)}`;
    // Lo que dice el cargador (Dhemax) de este bus: la carga real si calza sin dudas.
    const m = dh?.porBus.get(b.id ?? ppu) ?? null;
    const real = m && (m.estado === 'confirmada' || m.estado === 'probable') ? m.carga : null;
    const difiere = (v, w) => v != null && w != null && Math.abs(v - w) > TOLERANCIA;
    // Corrección propuesta (SGDC y cargador de acuerdo, sin duda): extra al problema, no lo reemplaza.
    const cor = t.anulado === true ? null : correccionDe(b, m, l, { autoCorrige: false });
    if (cor?.tipo === 'PISTOLA') {
      info.correcciones.push({ tipo: 'pistola', ppu, anotado: cor.anotada, real: cor.pistola, evidencia: cor.texto, clave: cor.clave });
    } else if (cor?.tipo === 'PCT_FINAL') {
      info.correcciones.push({ tipo: 'pctFinal', ppu, anotado: cor.anotado, real: cor.pct, evidencia: cor.texto, clave: cor.clave });
    }
    // Cambio de pistola anotado a una pistola distinta de la que muestra el cargador.
    if (real?.continuaEn && b.incidencia === 'CAMBIO' && b.pistolaNueva && real.continuaEn !== b.pistolaNueva) {
      out.push(`${ppu}: anotado con cambio a ${b.pistolaNueva} y el cargador lo tiene siguiendo en ${real.continuaEn} ` +
        `(${textoCarga(real, hm)}).`);
    }
    if (anotadoCargado && !l.length) {
      // ¿Hay una carga doble en su misma pistola? Esa es probablemente la suya.
      const d = conPistola && dobles.find((x) => x.c.pistola === b.coordenada && !explicadas.has(x.c));
      if (d) {
        explicadas.add(d.c);
        explicadas.add(d.otra);
        sugerencias.push({
          pistola: d.c.pistola, de: d.ppu, a: ppu, inicio: d.c.inicio.toISOString(),
          kwh: d.c.kwh ?? null, soh: d.c.soh ?? null, socInicio: d.c.socInicio ?? null, socFin: d.c.socFin ?? null,
        });
        info.erroresSgdc.push(`${ppu}: anotado como cargado (${como}) sin carga a su nombre. En el SGDC la carga de ` +
          `${d.c.pistola} (${hm(d.c.inicio)}, ${pct(d.c.socInicio, d.c.socFin)}) está a nombre de ${d.ppu}, ` +
          `que a esa hora también cargaba en ${d.otra.pistola}: probablemente es de ${ppu} y la patente se ` +
          'digitó mal en el cargador. Lo anotado está bien; el error es del SGDC.');
        continue;
      }
      if (real) {
        // El SGDC no la tiene pero el cargador sí: solo importa que el % final calce.
        if (!finalDudoso(real) && !calzaFinal(b.pctFinal, real.sf, TOLERANCIA)) {
          out.push(`${ppu}: anotado con ${b.pctFinal} % final y el cargador dice ${real.sf} % ` +
            `(${textoCarga(real, hm)}; el SGDC no tiene la carga).`);
        } else {
          info.confirmadas.push(ppu);
        }
      } else if (m?.estado === 'ambigua') {
        out.push(`${ppu}: anotado como cargado (${como}); el SGDC no tiene la carga y en el cargador ` +
          `${b.coordenada} hay ${m.opciones.length} que podrían ser suyas: ${m.opciones.map((x) => textoCarga(x, hm)).join(' · ')}.`);
      } else if (m?.otraPistola) {
        out.push(`${ppu}: anotado como cargado (${como}), pero el cargador ${b.coordenada} no tiene una carga que ` +
          `calce y en ${m.otraPistola.pistola} hay una sin anotar con el mismo % inicial ` +
          `(${textoCarga(m.otraPistola, hm)}): ¿se anotó mal la pistola?`);
      } else if (dh && conPistola) {
        out.push(`${ppu}: anotado como cargado (${como}) y ni el SGDC ni el cargador (Dhemax) tienen una carga ` +
          `que calce en ${b.coordenada}.`);
      } else if (b.sinPatio === true) {
        sinPatio.push(`${ppu} (${como})`);
      } else {
        out.push(`${ppu}: anotado como cargado (${como}) y el SGDC no tiene ninguna carga suya en el turno.`);
      }
    }
    if ((b.jornada === 'NI' || b.motivo) && anotadoCargado) {
      out.push(`${ppu}: marcado sin carga (${b.motivo ?? "NI"}) pero tiene ${como}.`);
    }
    // Anotado con carga y el SGDC también la tiene: ¿cuadran la pistola y el % final?
    // Cambio de pistola anotado: el SGDC tiene que tener también la parte en la pistola nueva.
    if (l.length && conPistola && b.incidencia === 'CAMBIO' && PISTOLAS.has(b.pistolaNueva) &&
        !l.some((c) => c.pistola === b.pistolaNueva)) {
      out.push(`${ppu}: anotado con cambio de pistola ${b.coordenada} → ${b.pistolaNueva} y el SGDC lo tiene en ` +
        `${[...new Set(l.map((c) => c.pistola ?? '—'))].join(', ')}.`);
    }
    if (l.length && conPistola && !l.some((c) => c.pistola === b.coordenada)) {
      out.push(`${ppu}: anotado en ${b.coordenada} y el SGDC lo tiene cargando en ` +
        `${[...new Set(l.map((c) => c.pistola ?? '—'))].join(', ')}.`);
    }
    const ultima = l[l.length - 1];
    if (l.length && real) {
      // Si el bombero coincide con el SGDC (finalizada, no cortada), está bien. Si no, manda el cargador: el
      // SGDC puede haberse cortado o haber partido tarde.
      const sgdcSirve = ultima?.estado === 'Finalizada' && ultima.socFin != null && !cortadas.has(ultima);
      const conSgdc = sgdcSirve && !difiere(b.pctFinal, ultima.socFin);
      if (!conSgdc && !finalDudoso(real) && !calzaFinal(b.pctFinal, real.sf, TOLERANCIA)) {
        out.push(`${ppu}: anotado con ${b.pctFinal} % final y el cargador dice ${real.sf} % (${textoCarga(real, hm)}` +
          `${ultima?.socFin != null && ultima.socFin !== real.sf ? `; el SGDC dice ${ultima.socFin} %` : ''}).`);
      }
    } else if (ultima?.estado === 'Finalizada' && ultima.socFin != null && !cortadas.has(ultima) && b.pctFinal != null &&
        Math.abs(b.pctFinal - ultima.socFin) > TOLERANCIA) {
      if (b.sinPatio === true) {
        sinPatio.push(`${ppu} (anotado ${b.pctFinal} % final, el SGDC alcanzó a registrar ${ultima.socFin} %)`);
      } else {
        out.push(`${ppu}: anotado con ${b.pctFinal} % final y el SGDC dice ${ultima.socFin} % ` +
          `(${ultima.pistola ?? '—'}, terminó ${hm(finDe(ultima))}).`);
      }
    }
    // El SGDC tiene carga y la foto no tiene pistola: sin % final, o marcado sin carga (NI / motivo, SRSC67 20-11: 132 kWh
    // y en la foto "NI"). Si además sube el %, ya lo avisó el punto 2 (marcado sin carga pero con %).
    const sinCargaEnFoto = b.jornada === 'NI' || !!b.motivo;
    if (l.length && !conPistola && !sube && (b.pctFinal == null || sinCargaEnFoto)) {
      const u = l[l.length - 1];
      const f = aFecha(u.inicio ?? u.reserva);
      // Pasada corta (sube 2 puntos o menos, SRSC39 21-11: 76→78, 9,7 kWh): no cambia nada para operaciones.
      const subeSgdc = l[0].socInicio != null && u.socFin != null ? u.socFin - l[0].socInicio : null;
      if (subeSgdc != null && subeSgdc <= CORTA_PCT) {
        info.cortas.push(`${ppu} (${u.pistola ?? '—'}, ${pct(l[0].socInicio, u.socFin)}${f ? `, ${hm(f)}` : ''})`);
        continue;
      }
      out.push(`${ppu}: el SGDC tiene carga (${u.pistola ?? '—'}, ${pct(l[0].socInicio, u.socFin)}` +
        `${f ? `, ${hm(f)}` : ''}) y en el turno no quedó anotada` +
        `${sinCargaEnFoto ? ` (en la foto figura sin carga: ${b.motivo ?? 'NI'}, sin pistola)` : ''}.`);
    }
  }
  // Cargas del cargador que no son de ningún bus anotado y que el SGDC tampoco tiene.
  for (const s of dh?.sinAnotar ?? []) {
    out.push(`Cargador ${s.pistola}: cargó ${textoCarga(s, hm)} y no quedó anotado ningún bus ` +
      '(el SGDC tampoco tiene la carga).');
  }
  // Cargas dobles que ningún bus anotado explica: igual se avisan (una es de otro bus).
  const avisadas = new Set();
  for (const { ppu, c, otra } of dobles) {
    if (explicadas.has(c) || explicadas.has(otra) || avisadas.has(c)) continue;
    avisadas.add(c);
    avisadas.add(otra);
    out.push(`${ppu}: el SGDC lo tiene cargando en dos pistolas a la vez (${c.pistola} ${hm(c.inicio)} y ` +
      `${otra.pistola} ${hm(otra.inicio)}). Una de esas cargas es de otro bus (patente mal digitada).`);
  }

  const externos = new Set((t.externos ?? []).map((e) => norma(e.ppu ?? e.id)));
  for (const [ppu, l] of porBus) {
    if (enFoto.has(ppu) || externos.has(ppu)) continue;
    const u = l[l.length - 1];
    const f = aFecha(u.inicio ?? u.reserva);
    out.push(`${ppu}: cargó en el terminal según el SGDC (${u.pistola ?? '—'}${f ? `, ${hm(f)}` : ''}) ` +
      'y no está en el turno ni en otros terminales.');
  }
  return out;
}

/**
 * Decide si un turno cerrado ya se puede revisar. El turno termina cuando se cerró (`cerradoEn`; sus cargas son
 * las que empezaron antes) y basta la primera publicación del SGDC posterior al cierre, siempre que ninguna
 * carga del turno siga "En proceso" (se cerró con un bus cargando): en ese caso espera la siguiente
 * publicación y, pasadas ESPERA_SGDC_H, se revisa igual. Sin `cerradoEn` se usa `hasta` + MARGEN_FIN_MIN.
 * @param cargasTurno cargas del SGDC del turno conocidas (Date en inicio)
 */
export function estadoRevision({ cerradoEn, hasta, datosSgdc, cargasTurno = [], ahora, hayDhemax: dh = false }) {
  const cierre = aFecha(cerradoEn);
  const finEfectivo = cierre ?? hasta;
  const datosOk = !!datosSgdc && datosSgdc.getTime() >= finEfectivo.getTime() + (cierre ? 1 : MARGEN_FIN_MIN * 60000);
  const enProceso = cargasTurno.filter((c) => /proceso/i.test(String(c.estado ?? ''))).length;
  const terminoHace = ahora - finEfectivo;
  const pasoEspera = terminoHace > ESPERA_SGDC_H * 3600000;
  const sgdcCubre = datosOk && (!cierre || enProceso === 0 || pasoEspera);
  const soloCargadores = !sgdcCubre && pasoEspera && dh;
  let espera = null;
  if (!sgdcCubre) {
    espera = datosOk ? `espera: ${enProceso} cargas del SGDC siguen en proceso`
      : `espera al SGDC posterior al cierre (${hm(finEfectivo)}; datos ${datosSgdc ? hm(datosSgdc) : '—'})`;
  }
  return { finEfectivo, terminoHace, sgdcCubre, soloCargadores, enProceso, espera };
}

/**
 * @param db Firestore
 * @param cargas cargas del SGDC de esta pasada (inicio/reserva/fin como Date)
 * @param datosSgdc Date de los datos del Power BI del SGDC
 * @param probar true = solo muestra, no escribe
 */
export async function revisarTurnos(db, cargas, datosSgdc, { probar = false, desdeH = VENTANA_H } = {}) {
  const ahora = new Date();
  const s = await db.collection('turnos')
    .where('cerradoEn', '>=', Timestamp.fromDate(new Date(ahora.getTime() - desdeH * 3600 * 1000))).get();
  for (const d of s.docs) {
    const t = d.data();
    if (t.anulado === true || !t.dia || !['AM', 'PM'].includes(t.turno)) continue;
    const dia = t.dia.replace(/-/g, '');
    const [desde, hasta] = ventana(t.turno, dia);
    const titulo = `${nombre(t.turno)} del ${+dia.slice(6, 8)}/${+dia.slice(4, 6)}`;
    const candado = db.collection('privado').doc(`revision_${d.id}`);
    const refDh = db.collection('dhemaxTurnos').doc(d.id);
    const revisado = !probar && (await candado.get()).exists;
    const conDh = !probar && (await refDh.get()).exists;
    if (revisado && conDh) continue;

    // Fin del turno = su cierre. "En proceso" se mira con las cargas de esta pasada (sin leer Firestore).
    const enVentana = (c, fin) => {
      const f = c.inicio ?? c.reserva;
      return f && f >= desde && f < fin && /camilo/i.test(String(c.terminal ?? 'Camilo Henriquez'));
    };
    const finPrevio = aFecha(t.cerradoEn) ?? hasta;
    // Si el SGDC no llega (caído o atrasado), pasadas ESPERA_SGDC_H se revisa solo con los cargadores.
    const { finEfectivo, terminoHace, sgdcCubre, soloCargadores, espera } = estadoRevision({
      cerradoEn: t.cerradoEn, hasta, datosSgdc, ahora, hayDhemax: hayDhemax(),
      cargasTurno: (cargas ?? []).filter((c) => enVentana(c, finPrevio)),
    });
    const revisar = !revisado && (sgdcCubre || soloCargadores);
    const guardarDh = !conDh && terminoHace > ESPERA_DHEMAX_MIN * 60000 && hayDhemax();
    if (!revisar && !guardarDh) {
      if (!revisado) console.log(`Revisión de turnos: el ${titulo} ${espera ?? 'espera'}.`);
      continue;
    }

    // Cargas del SGDC de la ventana: las guardadas por el robot + las de esta pasada.
    const todas = new Map();
    const g = await db.collection('sgdc')
      .where('inicio', '>=', Timestamp.fromDate(desde)).where('inicio', '<', Timestamp.fromDate(finEfectivo)).get();
    for (const x of g.docs) {
      const c = x.data();
      todas.set(x.id, { ...c, inicio: aFecha(c.inicio), reserva: aFecha(c.reserva), fin: aFecha(c.fin) });
    }
    for (const c of cargas ?? []) todas.set(String(c.id).replace(/\//g, '_'), c);
    const delTurno = [...todas.values()].filter((c) => {
      return enVentana(c, finEfectivo);
    });

    // Cruce con los cargadores (Dhemax). Si falla, se revisa como antes, solo con el SGDC.
    // Si Dhemax falló o vino vacío para este turno, no se vuelve a pedir antes de DHEMAX_REINTENTO_H
    // (privado/dhemax_intento_<turno>; solo se lee y escribe cuando de verdad se iba a pedir).
    let dh = null;
    if (hayDhemax()) {
      const refIntento = db.collection('privado').doc(`dhemax_intento_${d.id}`);
      const ultimo = probar ? null : aFecha((await refIntento.get()).data()?.fecha)?.getTime() ?? null;
      if (ultimo != null && ahora.getTime() - ultimo < DHEMAX_REINTENTO_H * 3600000) {
        console.log(`Revisión de turnos: ${titulo} · Dhemax falló hace poco; no se pide de nuevo antes de ${DHEMAX_REINTENTO_H} h.`);
      } else {
        let fallo = false;
        try {
          const deDhemax = await cargasDhemaxEntre(desde, finEfectivo);
          // Ninguna carga en todo un turno es una respuesta vacía de Dhemax, no un turno sin cargas.
          if (deDhemax.length) dh = emparejar(t.buses ?? [], deDhemax, delTurno.filter((c) => c.pistola && c.inicio));
          else fallo = true;
          console.log(`Revisión de turnos: ${titulo} · ${deDhemax.length} cargas en los cargadores (Dhemax)` +
            `${deDhemax.length ? '' : ': sin datos del cargador, se usa solo el SGDC'}.`);
        } catch (e) {
          fallo = true;
          console.log(`Revisión de turnos: Dhemax no respondió para el ${titulo} (${e.message}); se usa solo el SGDC.`);
        }
        if (fallo && !probar) await refIntento.set({ fecha: FieldValue.serverTimestamp(), turnoId: d.id }).catch(() => {});
      }
    }
    if (guardarDh && dh && !probar) {
      await refDh.set({
        turnoId: d.id, dia: t.dia, turno: t.turno, calculado: FieldValue.serverTimestamp(), ...paraFirestore(dh),
      });
    }
    if (!revisar || (soloCargadores && !dh)) continue;

    const sugerencias = [];
    const sinPatio = [];
    const info = {};
    const problemas = problemasTurno(t, delTurno, sugerencias, sinPatio, dh, info);
    for (const h of cortesSgdc(delTurno).horas) {
      console.log(`Revisión de turnos: el SGDC se cortó ~${hm(h)} en el ${titulo}; ` +
        `${dh ? 'esas cargas se comparan con el cargador.' : 'no se revisa el % final de esas cargas.'}`);
    }
    console.log(`Revisión de turnos: ${titulo} (${t.cerradoPor === 'robot' ? 'cerró el automático' : 'cerrado'}) · ` +
      `${delTurno.length} cargas SGDC${soloCargadores ? ' (SGDC sin datos del turno: solo cargadores)' : ''} · ` +
      `${info.confirmadas.length} confirmadas con el cargador · ` +
      `${problemas.length ? `${problemas.length} a revisar` : 'todo cuadra'}.`);
    for (const p of problemas) console.log('   ', p);
    for (const p of info.erroresSgdc) console.log('    (error del SGDC, no cuenta)', p);
    for (const p of dh?.continuadas ?? []) console.log('    (carga continuada en otra pistola)', p);
    if (info.cortas.length) console.log(`    cargas cortas del SGDC sin anotar (no cuentan): ${info.cortas.join(' · ')}`);
    if (sinPatio.length) console.log(`    anotadas sin patio en vivo (no se acusan): ${sinPatio.join(' · ')}`);
    for (const x of info.correcciones) console.log(`    corrección propuesta: ${x.ppu} ${x.tipo} ${x.anotado} → ${x.real}`);
    for (const x of sugerencias) console.log(`    sugerencia: carga de ${x.pistola} ${x.de} → ${x.a} (${x.kwh ?? '—'} kWh)`);
    if (probar) continue;

    // El candado primero: si otra corrida ya lo revisó, no se repite el aviso.
    try {
      await candado.create({
        fecha: FieldValue.serverTimestamp(), turno: d.id, problemas: problemas.length, sinPatio: sinPatio.length,
        conDhemax: !!dh, confirmadas: info.confirmadas.length,
      });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) continue;
      throw e;
    }
    // Resultado en el mismo turno: el historial de la app muestra ✓✓ / ✓ / ⚠ N sin leer nada más.
    await db.collection('turnos').doc(d.id).update({
      verificacion: {
        sgdc: !soloCargadores, cargadores: !!dh, problemas: problemas.length,
        confirmadas: info.confirmadas.length, correcciones: info.correcciones, revisado: FieldValue.serverTimestamp(),
      },
    });
    if (!problemas.length && !info.erroresSgdc.length) continue;
    if (!problemas.length) {
      // Solo errores del SGDC: lo anotado está bien; se deja como aviso informativo.
      await db.collection('errores').doc(`revision_${dia}_${t.turno}`).set({
        origen: 'revisión de turno',
        donde: 'GitHub Actions · sgdc-robot',
        mensaje: `Turno ${titulo} (cerró ${t.cerradoPorNombre ?? '—'}): lo anotado cuadra, pero el SGDC tiene ` +
          `${info.erroresSgdc.length === 1 ? 'una carga' : `${info.erroresSgdc.length} cargas`} a nombre de otro bus ` +
          '(patente mal digitada en el cargador). No hay que corregir nada en el semáforo.\n' +
          info.erroresSgdc.map((p) => `• ${p}`).join('\n'),
        stack: '',
        plataforma: 'GitHub',
        ultima: FieldValue.serverTimestamp(),
        ultimoUsuario: 'robot',
        usuarios: FieldValue.arrayUnion('robot'),
        veces: FieldValue.increment(1),
        resuelto: false,
        turnoId: d.id,
        sugerencias,
      }, { merge: true });
      console.log(`Aviso al admin: turno ${titulo}, solo errores del SGDC (no cuentan).`);
      continue;
    }
    const contra = dh ? 'el SGDC ni con los cargadores' : 'el SGDC';
    await db.collection('errores').doc(`revision_${dia}_${t.turno}`).set({
      origen: 'revisión de turno',
      donde: 'GitHub Actions · sgdc-robot',
      mensaje: `Turno ${titulo} (cerró ${t.cerradoPorNombre ?? '—'}): ${problemas.length} ` +
        `${problemas.length === 1 ? 'cosa no cuadra' : 'cosas no cuadran'} con ${contra}. ` +
        (soloCargadores ? 'El SGDC no tiene datos de este turno: se revisó solo con los cargadores (Dhemax). ' : '') +
        'Revísalo en HISTORIAL DE TURNOS y pregunta a quien lo anotó.\n' +
        problemas.map((p) => `• ${p}`).join('\n') +
        info.correcciones.map((x) => `\n→ Se puede corregir desde el Historial: ${x.ppu} ${x.anotado}${x.tipo === 'pctFinal' ? ' %' : ''} → ${x.real}${x.tipo === 'pctFinal' ? ' %' : ''}`).join('') +
        (info.erroresSgdc.length
          ? `\n\nError del SGDC (lo anotado está bien, no cuenta): ${info.erroresSgdc.map((p) => `\n• ${p}`).join('')}`
          : '') +
        (info.confirmadas.length
          ? `\n\n${info.confirmadas.length} ${info.confirmadas.length === 1 ? 'carga que el SGDC no tiene quedó confirmada' : 'cargas que el SGDC no tiene quedaron confirmadas'} con el cargador.`
          : '') +
        (sinPatio.length
          ? `\n\nAnotadas con el patio sin datos en vivo (el SGDC no las tiene completas; se deja lo anotado, ` +
            `no se acusan): ${sinPatio.join(' · ')}.`
          : ''),
      stack: '',
      plataforma: 'GitHub',
      ultima: FieldValue.serverTimestamp(),
      ultimoUsuario: 'robot',
      usuarios: FieldValue.arrayUnion('robot'),
      veces: FieldValue.increment(1),
      resuelto: false,
      // Para el botón "Asignar esta carga a …" de la app (corrige la foto del turno).
      turnoId: d.id,
      sugerencias,
    }, { merge: true });
    console.log(`Aviso al admin: turno ${titulo}, ${problemas.length} a revisar.`);
  }
}

// Prueba local (solo lee, no escribe nada):
//   node tools/revision_turnos.mjs --probar [--horas 96] [tools/serviceAccount.json]
if (process.argv[1]?.endsWith('revision_turnos.mjs')) {
  const args = process.argv.slice(2);
  if (!args.includes('--probar')) {
    console.log('Solo se corre a mano con --probar (en el robot va dentro de sgdc_sync.mjs).');
    process.exit(1);
  }
  const i = args.indexOf('--horas');
  const horas = i >= 0 ? Number(args[i + 1]) : VENTANA_H;
  const llave = args.find((a) => a.endsWith('.json')) ?? new URL('./serviceAccount.json', import.meta.url).pathname;
  const { readFileSync } = await import('node:fs');
  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(llave, 'utf8'))) });
  await revisarTurnos(admin.firestore(), [], new Date(), { probar: true, desdeH: horas });
}
