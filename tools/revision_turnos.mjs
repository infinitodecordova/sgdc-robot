// Revisión de los turnos cerrados contra el SGDC (corre con el robot del SGDC, después del cierre
// automático y la corrección).
//
// Cuando el Power BI del SGDC ya cubre el final de un turno cerrado (por una persona o por el robot),
// compara la foto del turno con las cargas del SGDC de esa ventana y avisa al admin en ERRORES si:
//   1. Un bus quedó anotado como cargado (pistola o % que sube) y el SGDC no tiene ninguna carga suya.
//   2. Un bus quedó "BUS NO INGRESADO A CARGA" (NI) pero con pistola o % que sube.
//   3. El SGDC tiene una carga de un bus que en el turno no quedó anotada (sin pistola ni % final).
//   4. El SGDC tiene una carga de un bus que no está en la foto del turno ni en otros terminales.
//   5. El SGDC tiene un bus cargando en dos pistolas a la vez (patente mal digitada en el cargador). Si en
//      esa pistola hay un bus anotado sin carga a su nombre, se dice que la carga es probablemente suya.
//   6. Un bus anotado con pistola en la que el SGDC no lo tiene, o con un % final que difiere en más de
//      2 puntos del de su última carga finalizada en el SGDC (p. ej. el 100 % falso del patio).
//      No se revisa el % de las cargas cortadas por una caída del SGDC (ver `cortesSgdc`).
// Los buses que la app marcó `sinPatio` (carga anotada con el patio sin datos en vivo) no se acusan por
// faltar en el SGDC ni por el % final: esas cargas no quedan en el sistema. Se listan aparte, como dato.
// Cada turno se revisa una sola vez (candado en privado/revision_<id del turno>).
// No cambia nada del turno: solo avisa. Lecturas: ~3 turnos + ~3 candados por pasada y, una vez por
// turno, sus cargas del SGDC (~40–80).

import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { chile } from './auto_correccion.mjs';
import { ventana } from './cierre_automatico.mjs';

// El SGDC tiene que llegar al menos hasta 20 min después del fin del turno (cargas que terminan tarde).
const MARGEN_FIN_MIN = 20;
// Solo turnos cerrados en las últimas 36 h (después de eso ya no se espera más al SGDC).
const VENTANA_H = 36;
const SUBE = 2; // puntos: % final que supera al inicial en más que esto = se anotó como cargado
const TOLERANCIA = 2; // puntos: diferencia aceptada entre el % final anotado y el del SGDC
const PISTOLAS = new Set([
  'B7-L', 'B7-R', 'B8-L', 'B8-R', 'B9-L', 'B9-R', 'B10-L', 'B10-R', 'B11-L', 'B11-R',
  'B12-L', 'B12-R', 'B13-L', 'B13-R', 'A1-L', 'A1-R', 'A2-L', 'A2-R', 'A3-L', 'A3-R',
  'A4-L', 'A4-R', 'A5-L', 'A5-R', 'A6-L', 'A6-R',
]);

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
export function problemasTurno(t, cargas, sugerencias = [], sinPatio = []) {
  const porBus = new Map();
  for (const c of cargas) {
    const p = norma(c.ppu);
    if (!porBus.has(p)) porBus.set(p, []);
    porBus.get(p).push(c);
  }
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
        out.push(`${ppu}: anotado como cargado (${como}) sin carga a su nombre. En el SGDC la carga de ` +
          `${d.c.pistola} (${hm(d.c.inicio)}, ${pct(d.c.socInicio, d.c.socFin)}) está a nombre de ${d.ppu}, ` +
          `que a esa hora también cargaba en ${d.otra.pistola}: probablemente es de ${ppu} y la patente se ` +
          'digitó mal en el cargador. Lo anotado está bien; el error es del SGDC.');
        continue;
      }
      if (b.sinPatio === true) sinPatio.push(`${ppu} (${como})`);
      else out.push(`${ppu}: anotado como cargado (${como}) y el SGDC no tiene ninguna carga suya en el turno.`);
    }
    if (b.jornada === 'NI' && anotadoCargado) {
      out.push(`${ppu}: marcado NI (no ingresado a carga) pero tiene ${como}.`);
    }
    // Anotado con carga y el SGDC también la tiene: ¿cuadran la pistola y el % final?
    if (l.length && conPistola && !l.some((c) => c.pistola === b.coordenada)) {
      out.push(`${ppu}: anotado en ${b.coordenada} y el SGDC lo tiene cargando en ` +
        `${[...new Set(l.map((c) => c.pistola ?? '—'))].join(', ')}.`);
    }
    const ultima = l[l.length - 1];
    if (ultima?.estado === 'Finalizada' && ultima.socFin != null && !cortadas.has(ultima) && b.pctFinal != null &&
        Math.abs(b.pctFinal - ultima.socFin) > TOLERANCIA) {
      if (b.sinPatio === true) {
        sinPatio.push(`${ppu} (anotado ${b.pctFinal} % final, el SGDC alcanzó a registrar ${ultima.socFin} %)`);
      } else {
        out.push(`${ppu}: anotado con ${b.pctFinal} % final y el SGDC dice ${ultima.socFin} % ` +
          `(${ultima.pistola ?? '—'}, terminó ${hm(finDe(ultima))}).`);
      }
    }
    if (l.length && !conPistola && b.pctFinal == null && b.jornada !== 'NI') {
      const u = l[l.length - 1];
      const f = aFecha(u.inicio ?? u.reserva);
      out.push(`${ppu}: el SGDC tiene carga (${u.pistola ?? '—'}, ${pct(l[0].socInicio, u.socFin)}` +
        `${f ? `, ${hm(f)}` : ''}) y en el turno no quedó anotada.`);
    }
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
 * @param db Firestore
 * @param cargas cargas del SGDC de esta pasada (inicio/reserva/fin como Date)
 * @param datosSgdc Date de los datos del Power BI del SGDC
 * @param probar true = solo muestra, no escribe
 */
export async function revisarTurnos(db, cargas, datosSgdc, { probar = false, desdeH = VENTANA_H } = {}) {
  if (!datosSgdc) return;
  const ahora = new Date();
  const s = await db.collection('turnos')
    .where('cerradoEn', '>=', Timestamp.fromDate(new Date(ahora.getTime() - desdeH * 3600 * 1000))).get();
  for (const d of s.docs) {
    const t = d.data();
    if (t.anulado === true || !t.dia || !['AM', 'PM'].includes(t.turno)) continue;
    const dia = t.dia.replace(/-/g, '');
    const [desde, hasta] = ventana(t.turno, dia);
    const titulo = `${nombre(t.turno)} del ${+dia.slice(6, 8)}/${+dia.slice(4, 6)}`;
    if (datosSgdc.getTime() < hasta.getTime() + MARGEN_FIN_MIN * 60000) {
      console.log(`Revisión de turnos: el ${titulo} espera al SGDC (datos ${hm(datosSgdc)}).`);
      continue;
    }
    const candado = db.collection('privado').doc(`revision_${d.id}`);
    if (!probar && (await candado.get()).exists) continue;

    // Cargas de la ventana: las guardadas por el robot + las de esta pasada.
    const todas = new Map();
    const g = await db.collection('sgdc')
      .where('inicio', '>=', Timestamp.fromDate(desde)).where('inicio', '<', Timestamp.fromDate(hasta)).get();
    for (const x of g.docs) {
      const c = x.data();
      todas.set(x.id, { ...c, inicio: aFecha(c.inicio), reserva: aFecha(c.reserva), fin: aFecha(c.fin) });
    }
    for (const c of cargas ?? []) todas.set(String(c.id).replace(/\//g, '_'), c);
    const delTurno = [...todas.values()].filter((c) => {
      const f = c.inicio ?? c.reserva;
      const terminal = String(c.terminal ?? 'Camilo Henriquez');
      return f && f >= desde && f < hasta && /camilo/i.test(terminal);
    });

    const sugerencias = [];
    const sinPatio = [];
    const problemas = problemasTurno(t, delTurno, sugerencias, sinPatio);
    for (const h of cortesSgdc(delTurno).horas) {
      console.log(`Revisión de turnos: el SGDC se cortó ~${hm(h)} en el ${titulo}; no se revisa el % final de esas cargas.`);
    }
    console.log(`Revisión de turnos: ${titulo} (cerró ${t.cerradoPorNombre ?? '—'}) · ` +
      `${delTurno.length} cargas SGDC · ${problemas.length ? `${problemas.length} a revisar` : 'todo cuadra'}.`);
    for (const p of problemas) console.log('   ', p);
    if (sinPatio.length) console.log(`    anotadas sin patio en vivo (no se acusan): ${sinPatio.join(' · ')}`);
    for (const x of sugerencias) console.log(`    sugerencia: carga de ${x.pistola} ${x.de} → ${x.a} (${x.kwh ?? '—'} kWh)`);
    if (probar) continue;

    // El candado primero: si otra corrida ya lo revisó, no se repite el aviso.
    try {
      await candado.create({
        fecha: FieldValue.serverTimestamp(), turno: d.id, problemas: problemas.length, sinPatio: sinPatio.length,
      });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) continue;
      throw e;
    }
    if (!problemas.length) continue;
    await db.collection('errores').doc(`revision_${dia}_${t.turno}`).set({
      origen: 'revisión de turno',
      donde: 'GitHub Actions · sgdc-robot',
      mensaje: `Turno ${titulo} (cerró ${t.cerradoPorNombre ?? '—'}): ${problemas.length} ` +
        `${problemas.length === 1 ? 'bus no cuadra' : 'buses no cuadran'} con el SGDC. ` +
        'Revísalo en HISTORIAL DE TURNOS y pregunta a quien lo anotó.\n' +
        problemas.map((p) => `• ${p}`).join('\n') +
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
