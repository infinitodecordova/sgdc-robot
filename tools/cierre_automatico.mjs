// Cierre automático del turno si nadie lo cerró.
//
// Corre con el robot del SGDC (a las :40). Solo actúa en el hueco entre turnos:
//   - Nocturno (termina 07:30): se cierra en la pasada de las 07:40, antes de que entre el diurno (08:30).
//   - Diurno (termina 20:00): se cierra en la pasada de las 20:40, antes de que entre el nocturno (22:00).
//
// Antes de cerrar:
//   1. Comprueba con el SGDC: corrige % inicial, % final, pistola y jornada (como "Corregir con SGDC").
//   2. Comprueba el taller: marca PT a los que mantenimiento tiene en taller y se lo quita a los que ya salieron.
//   3. Si el Power BI del SGDC no está al día, comprueba con los cargadores (Dhemax, dhemax_cruce.mjs) y
//      corrige SOLO las cargas que calzan sin duda (confirmadas por la patente del SGDC, o misma pistola
//      anotada y % inicial a ±3 sin otra carga parecida): % inicial, % final y jornada. Lo demás queda como lo
//      anotaron los bomberos y se avisa al admin. Sin Dhemax (o si no responde), cierra con lo anotado y avisa.
//      Si el taller no está al día, no toca PT y avisa.
// Después guarda la foto del turno (igual que la app) y limpia el semáforo, manteniendo taller, vidrio,
// fuera de servicio, Pie Andino y San Carlos.
//
// Se apaga desde la app (config/cierreAuto.activo = false).

import {
  chile, cambiosSgdc, cambiosJornada, condicionDe, jornadaDe, reasignarReservas, ultimoCierre, turnoManual, ETIQUETAS, fmt,
} from './auto_correccion.mjs';
import { calzaFinal, cargasDhemaxEntre, emparejar, hayDhemax, marcarEnCurso, PISTOLAS, textoCarga, finalDudoso } from './dhemax_cruce.mjs';

const PERSISTENTES = new Set(['PT', 'AV', 'FS', 'PIEA', 'TSC']);
// El Power BI se actualiza ~:27/:32. Para cerrar, sus datos tienen que llegar al menos hasta
// 40 minutos antes del fin del turno; si no, se considera caído.
const MARGEN_SGDC_MIN = 40;
// El reporte de taller sirve si tiene menos de 6 horas.
const MAX_ATRASO_TALLER_H = 6;

// Ventanas de cierre (hora de Chile, HHMM) y fin de cada turno.
const CIERRE = {
  PM: { desde: 740, hasta: 830, fin: [7, 30] }, // del día siguiente al que empezó
  AM: { desde: 2040, hasta: 2200, fin: [20, 0] },
};

/// Fecha real de una hora "de reloj" de Chile.
function fechaChile(y, mo, d, h, mi) {
  const reloj = Date.UTC(y, mo - 1, d, h, mi);
  let t = reloj;
  for (let i = 0; i < 2; i++) {
    const c = chile(new Date(t));
    const visto = Date.UTC(+c.dia.slice(0, 4), +c.dia.slice(4, 6) - 1, +c.dia.slice(6, 8),
      Math.floor(c.hm / 100), c.hm % 100);
    t += reloj - visto;
  }
  return new Date(t);
}

const partes = (dia) => [+dia.slice(0, 4), +dia.slice(4, 6), +dia.slice(6, 8)];
const conGuiones = (dia) => `${dia.slice(0, 4)}-${dia.slice(4, 6)}-${dia.slice(6, 8)}`;
const nombre = (t) => (t === 'PM' ? 'nocturno' : 'diurno');
const corta = (dia) => `${+dia.slice(6, 8)}/${+dia.slice(4, 6)}`;
const hora = (d) => d.toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'short', timeStyle: 'short' });

/// Ventana [desde, hasta) del turno: diurno 07:30–20:00, nocturno 20:00–07:30 del día siguiente.
export function ventana(turno, dia) {
  const [y, m, d] = partes(dia);
  if (turno === 'AM') return [fechaChile(y, m, d, 7, 30), fechaChile(y, m, d, 20, 0)];
  const sig = chile(new Date(fechaChile(y, m, d, 12, 0).getTime() + 24 * 3600 * 1000)).dia;
  const [y2, m2, d2] = partes(sig);
  return [fechaChile(y, m, d, 20, 0), fechaChile(y2, m2, d2, 7, 30)];
}

/// Turno que acaba de terminar según la hora: { turno, dia } (dia = AAAAMMDD en que empezó).
function turnoAnterior(ahora) {
  const { dia, hm } = chile(ahora);
  const ayer = chile(new Date(ahora.getTime() - 24 * 3600 * 1000)).dia;
  if (hm >= 2040) return { turno: 'AM', dia };
  if (hm < 740) return { turno: 'AM', dia: ayer };
  return { turno: 'PM', dia: ayer };
}

/// ¿Hay un cierre vigente (no anulado por el admin) de ese turno?
async function yaCerrado(db, turno, dia) {
  const s = await db.collection('turnos')
    .where('dia', '==', conGuiones(dia)).where('turno', '==', turno).get();
  return s.docs.some((d) => d.data().anulado !== true);
}

/// Aviso para el admin (sale en ERRORES, con el contador). Uno por turno.
async function avisar(db, id, mensaje) {
  const { FieldValue } = await import('firebase-admin/firestore');
  await db.collection('errores').doc(`cierre_${id}`).set({
    origen: 'cierre automático',
    donde: 'GitHub Actions · sgdc-robot',
    mensaje,
    stack: '',
    plataforma: 'GitHub',
    ultima: FieldValue.serverTimestamp(),
    ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'),
    veces: FieldValue.increment(1),
    resuelto: false,
  }, { merge: true });
  console.log('Aviso al admin:', mensaje);
}

/**
 * @param db Firestore
 * @param cargas cargas del SGDC de esta pasada (o null si el SGDC falló)
 * @param datosSgdc Date de los datos del Power BI del SGDC (o null)
 */
export async function cierreAutomatico(db, cargas, datosSgdc) {
  const cfg = (await db.doc('config/cierreAuto').get()).data() ?? {};
  if (cfg.activo === false) {
    console.log('Cierre automático: apagado.');
    return;
  }
  const ahora = new Date();
  const { hm } = chile(ahora);
  // Turnos manuales: se cierra el turno iniciado (si ya pasó su horario). Sin turno iniciado, nada.
  const manual = await turnoManual(db);
  if (manual.manual && !manual.turno) {
    console.log('Cierre automático: no hay turno iniciado.');
    return;
  }
  const { turno, dia } = manual.manual ? manual : turnoAnterior(ahora);
  const id = `${dia}_${turno}`;
  const v = CIERRE[turno];
  const [desde, hasta] = ventana(turno, dia);

  if (manual.manual && ahora < hasta) {
    console.log(`Cierre automático: el turno ${nombre(turno)} del ${corta(dia)} sigue en curso.`);
    return;
  }
  // Nunca se guarda un segundo cierre del mismo turno.
  if (await yaCerrado(db, turno, dia)) {
    console.log(`Cierre automático: el turno ${nombre(turno)} del ${corta(dia)} ya está cerrado.`);
    if (manual.manual) {
      // Lo iniciaron de nuevo después de cerrarlo: que lo cierre una persona (el admin puede reemplazar).
      await avisar(db, `${id}_duplicado`,
        `El turno ${nombre(turno)} del ${corta(dia)} sigue iniciado pero ya tenía un cierre. El robot no guarda ` +
        `otro. Ciérralo desde CERRAR TURNO (el admin puede reemplazar el anterior).`);
    }
    return;
  }
  // Fuera del hueco entre turnos no se cierra (borraría lo del equipo que ya entró): solo se avisa.
  const enVentana = hm >= v.desde && hm < v.hasta && chile(hasta).dia === chile(ahora).dia;
  if (!enVentana) {
    const atrasado = manual.manual
      ? ahora - hasta > 15 * 60000
      : (turno === 'PM' ? hm >= v.hasta : hm >= v.hasta || hm < 740);
    if (atrasado) {
      await avisar(db, `${id}_sin_cerrar`,
        manual.manual
          ? `El turno ${nombre(turno)} del ${corta(dia)} sigue iniciado y ya terminó su horario. Ciérralo desde ` +
            `CERRAR TURNO para que el equipo siguiente pueda iniciar el suyo.`
          : `Nadie cerró el turno ${nombre(turno)} del ${corta(dia)} y el robot no alcanzó a cerrarlo antes de que ` +
            `entrara el turno siguiente. Ciérralo tú desde CERRAR TURNO (elige ${nombre(turno)} y el día ${corta(dia)}).`);
    }
    return;
  }

  const { FieldValue, Timestamp } = await import('firebase-admin/firestore');

  // ¿Están al día los Power BI?
  const sgdcOk = !!cargas && !!datosSgdc && datosSgdc.getTime() >= hasta.getTime() - MARGEN_SGDC_MIN * 60000;
  const tallerDoc = (await db.doc('taller/flota').get()).data();
  const datosTaller = tallerDoc?.datos?.toDate?.() ?? null;
  const tallerOk = !!datosTaller && ahora - datosTaller < MAX_ATRASO_TALLER_H * 3600000;
  const enTaller = new Set(Object.keys(tallerDoc?.buses ?? {}));
  console.log(`Cierre automático del ${nombre(turno)} ${corta(dia)}: SGDC ${sgdcOk ? 'al día' : 'ATRASADO'}` +
    ` (${datosSgdc ? hora(datosSgdc) : 'sin datos'}), taller ${tallerOk ? 'al día' : 'ATRASADO'}.`);

  // Cargas del turno por PPU (para corregir: solo las de después del cierre anterior; para kWh: todas).
  const corte = await ultimoCierre(db, id);
  const delTurno = new Map();
  const paraCorregir = new Map();
  // Las del Power BI de esta pasada + las que el robot ya guardó (por si el reporte solo trae las de hoy
  // y el nocturno empezó ayer).
  const todas = new Map();
  const aFecha = (x) => x?.toDate?.() ?? x ?? null;
  if (sgdcOk) {
    const g = await db.collection('sgdc')
      .where('inicio', '>=', Timestamp.fromDate(desde)).where('inicio', '<', Timestamp.fromDate(hasta)).get();
    for (const x of g.docs) {
      const c = x.data();
      todas.set(x.id, { ...c, inicio: aFecha(c.inicio), reserva: aFecha(c.reserva), fin: aFecha(c.fin) });
    }
    for (const c of cargas ?? []) todas.set(String(c.id).replace(/\//g, '_'), c);
  }
  for (const c of todas.values()) {
    const f = c.inicio ?? c.reserva;
    if (!f || f < desde || f >= hasta) continue;
    if (!delTurno.has(c.ppu)) delTurno.set(c.ppu, []);
    delTurno.get(c.ppu).push(c);
    if (corte && f <= corte) continue;
    if (!paraCorregir.has(c.ppu)) paraCorregir.set(c.ppu, []);
    paraCorregir.get(c.ppu).push(c);
  }

  const docs = (await db.collection('semaforoch').get()).docs;
  // Errores de reserva anotados: la carga a nombre de otra patente es del bus que la anotó.
  const conReserva = docs.map((d) => ({ id: d.id, ...d.data() }));
  reasignarReservas(conReserva, delTurno);
  for (const m of reasignarReservas(conReserva, paraCorregir)) console.log(`Cierre automático: error de reserva ${m}.`);
  const ext = (await db.collection('externos').get()).docs;
  const batch = db.batch();
  const corregidos = [];
  const fotos = [];

  // SGDC atrasado: los cargadores (Dhemax) como respaldo. Solo cargas posteriores al último cierre y solo las
  // que calzan sin duda (estricta); el resto queda como lo anotaron y se avisa.
  let dh = null;
  const porDhemax = new Map(); // id del bus → carga del cargador
  if (!sgdcOk && hayDhemax()) {
    try {
      const sgdcParcial = [];
      const g = await db.collection('sgdc')
        .where('inicio', '>=', Timestamp.fromDate(desde)).where('inicio', '<', Timestamp.fromDate(hasta)).get();
      for (const x of g.docs) {
        const c = x.data();
        if (c.pistola && /camilo/i.test(String(c.terminal ?? 'Camilo'))) sgdcParcial.push({ ...c, inicio: aFecha(c.inicio), fin: aFecha(c.fin) });
      }
      const todasDh = await cargasDhemaxEntre(desde, hasta);
      // Ninguna carga en todo un turno es una respuesta vacía de Dhemax: se cierra como antes.
      if (!todasDh.length) throw new Error('Dhemax no trajo ninguna carga del turno');
      const deDhemax = todasDh.filter((c) => !corte || c.inicio > corte);
      // Las que siguen cargando: su % final todavía no es el definitivo (no se corrige con él).
      const enCurso = await marcarEnCurso(deDhemax);
      dh = emparejar(docs.map((x) => ({ id: x.id, ...x.data() })), deDhemax, sgdcParcial);
      for (const [id, r] of dh.porBus) if (r.estricta && r.carga) porDhemax.set(id, r.carga);
      console.log(`Cierre automático: SGDC atrasado → cargadores (Dhemax): ${deDhemax.length} cargas, ` +
        `${porDhemax.size} buses que calzan sin duda${enCurso ? `, ${enCurso} siguen cargando (sin tocar su % final)` : ''}.`);
    } catch (e) {
      dh = null;
      console.log(`Cierre automático: Dhemax no respondió (${e.message}); se cierra con lo anotado.`);
    }
  }
  const corregidosDh = [];

  for (const d of docs) {
    const b = { ...d.data() };
    const ppu = String(b.ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const real = porDhemax.get(d.id);
    const cambios = sgdcOk ? cambiosSgdc(b, paraCorregir.get(ppu) ?? []) : real ? cambiosDhemax(b, real) : {};
    if (tallerOk) {
      // La condición Taller va aparte de la carga (igual que la pestaña Taller y la corrección automática).
      const c = cambios.condicion ? cambios.condicion.despues : condicionDe(b);
      if (enTaller.has(ppu) && !c) cambios.condicion = { antes: b.condicion ?? null, despues: 'PT' };
      if (!enTaller.has(ppu) && c === 'PT') {
        cambios.condicion = { antes: b.condicion ?? 'PT', despues: null };
        if ((cambios.jornada?.despues ?? b.jornada) === 'PT') cambios.jornada = { antes: b.jornada ?? null, despues: null };
      }
    }
    if (Object.keys(cambios).length) {
      for (const [k, x] of Object.entries(cambios)) b[k] = x.despues;
      batch.update(d.ref, {
        ...Object.fromEntries(Object.entries(cambios).map(([k, x]) => [k, x.despues])),
        actualizado: FieldValue.serverTimestamp(),
        actualizadoPor: 'robot',
        actualizadoPorNombre: 'Cierre automático',
      });
      batch.set(d.ref.collection('historial').doc(), {
        fecha: FieldValue.serverTimestamp(), usuario: 'robot', nombre: 'Cierre automático', cambios,
        ...(real && !sgdcOk ? { fuente: 'cargador (Dhemax)', tr: real.tr } : {}),
      });
      const detalle = Object.entries(cambios)
        .map(([k, x]) => `${ETIQUETAS[k] ?? k}: ${fmt(x.antes)} → ${fmt(x.despues)}`).join(' · ');
      batch.set(db.collection('actividad').doc(), {
        fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Cierre automático',
        tipo: real && !sgdcOk ? 'Corrigió antes de cerrar (con el cargador)' : 'Corrigió antes de cerrar', detalle, ppu,
      });
      corregidos.push(`${ppu}: ${detalle}`);
      if (real && !sgdcOk) corregidosDh.push(`${ppu} (${detalle})`);
    }

    // kWh (suma) y SoH (última carga) del SGDC en el turno, para la foto.
    let kwh = null;
    let soh = null;
    let ultima = null;
    for (const c of delTurno.get(ppu) ?? []) {
      if (c.kwh != null) kwh = (kwh ?? 0) + c.kwh;
      if (c.soh != null && (!ultima || c.inicio > ultima)) {
        soh = c.soh;
        ultima = c.inicio;
      }
    }
    fotos.push({
      id: d.id,
      ppu: b.ppu ?? d.id,
      jornada: b.jornada ?? null,
      condicion: b.condicion ?? null,
      lugar: b.lugar ?? null,
      motivo: b.motivo ?? null,
      motivoTexto: b.motivoTexto ?? null,
      incidencia: b.incidencia ?? null,
      incidenciaTexto: b.incidenciaTexto ?? null,
      ppuReserva: b.ppuReserva ?? null,
      pistolaNueva: b.pistolaNueva ?? null,
      pctCambio: b.pctCambio ?? null,
      coordenada: b.coordenada ?? null,
      ruta: b.ruta ?? null,
      observacion: b.observacion ?? null,
      pctInicial: b.pctInicial ?? null,
      pctFinal: b.pctFinal ?? null,
      pct1: b.pct1 ?? null,
      pct2: b.pct2 ?? null,
      pct3: b.pct3 ?? null,
      kwConsumo: b.kwConsumo ?? null,
      soh: b.soh ?? null,
      sinPatio: b.sinPatio === true ? true : null,
      cargaInicio: b.cargaInicio ?? null,
      cargaFin: b.cargaFin ?? null,
      // Sin SGDC al día, los kWh del cargador (misma columna de energía del turno).
      kwhSgdc: kwh != null ? Math.round(kwh * 10) / 10 : real?.kwh != null && !sgdcOk ? Math.round(real.kwh * 10) / 10 : null,
      sohSgdc: soh,
    });

    // Limpieza para el turno siguiente: la condición (taller, vidrio, otro terminal…) sigue con su observación; la
    // carga, la jornada, el motivo y la incidencia son del turno. Una sigla vieja de condición en la jornada se deja.
    const mantener = condicionDe(b) != null;
    batch.update(d.ref, {
      coordenada: null, pctInicial: null, pctFinal: null, pct1: null, pct2: null, pct3: null, kwConsumo: null,
      sinPatio: null, cargaInicio: null, cargaFin: null,
      motivo: null, motivoTexto: null, incidencia: null, incidenciaTexto: null, pistolaNueva: null, pctCambio: null, ppuReserva: null, propuesta: null, propuestaDescartada: null,
      ...(PERSISTENTES.has(b.jornada) ? {} : { jornada: null }),
      ...(mantener ? {} : { condicion: null, lugar: null, observacion: null }),
      actualizado: FieldValue.serverTimestamp(),
      actualizadoPor: 'robot',
      actualizadoPorNombre: 'Cierre automático',
    });
  }

  const vacio = (x) => x == null || String(x).trim() === '';
  const cuenta = (f) => fotos.filter(f).length;
  const [y, m, dd] = partes(dia);
  batch.set(db.collection('turnos').doc(), {
    // El nocturno (o uno que se cierra otro día) queda en el día en que empezó (23:59), igual que en la app.
    fecha: Timestamp.fromDate(turno === 'PM' || chile(ahora).dia !== dia ? fechaChile(y, m, dd, 23, 59) : ahora),
    dia: conGuiones(dia),
    turno,
    cerradoPor: 'robot',
    cerradoPorNombre: 'Cierre automático',
    creado: FieldValue.serverTimestamp(),
    cerradoEn: Timestamp.fromDate(ahora),
    automatico: true,
    verificado: { sgdc: sgdcOk, taller: tallerOk, cargadores: !!dh },
    resumen: {
      cargadas: cuenta((b) => !vacio(b.coordenada)),
      pendientes: cuenta((b) => vacio(b.coordenada) && vacio(b.jornada) && !condicionDe(b) && vacio(b.motivo)),
      taller: cuenta((b) => condicionDe(b) === 'PT'),
      vidrio: cuenta((b) => condicionDe(b) === 'AV'),
      kwTotal: fotos.reduce((s, b) => s + (b.kwConsumo ?? 0), 0),
      externos: ext.length,
    },
    buses: fotos,
    ...(ext.length ? { externos: ext.map((e) => ({ id: e.id, ...e.data() })) } : {}),
  });
  for (const e of ext) batch.delete(e.ref);
  // Turnos manuales: el turno iniciado queda cerrado (el semáforo se bloquea hasta el siguiente).
  if (manual.manual) {
    batch.set(db.doc('config/app'), {
      turnoActual: { abierto: false, cerradoEn: FieldValue.serverTimestamp(), cerradoPor: 'Cierre automático' },
    }, { merge: true });
  }
  batch.set(db.collection('actividad').doc(), {
    fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Cierre automático', tipo: 'Cerró turno',
    detalle: `${nombre(turno) === 'nocturno' ? 'Nocturno' : 'Diurno'} del ${corta(dia)} · nadie lo cerró · ` +
      `${corregidos.length} corregidos · limpió el semáforo`,
  });
  // Candado: si otra corrida (el vigilante y un pedido a mano) intenta cerrar el mismo turno en la
  // misma hora, solo una lo hace. create() falla si el documento ya existe.
  const c = chile(ahora);
  try {
    await db.collection('privado').doc(`cierre_${id}_${c.dia}${String(Math.floor(c.hm / 100)).padStart(2, '0')}`)
      .create({ fecha: FieldValue.serverTimestamp() });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message)) {
      console.log(`Cierre automático: otra corrida ya está cerrando el ${nombre(turno)} del ${corta(dia)}; no se repite.`);
      return;
    }
    throw e;
  }
  await batch.commit();
  console.log(`Cierre automático: turno ${nombre(turno)} del ${corta(dia)} cerrado (${corregidos.length} corregidos).`);
  for (const r of corregidos) console.log('  ', r);

  // Aviso al admin: qué no se pudo comprobar.
  if (!sgdcOk && dh) {
    // Lo comprobó con los cargadores: avisa solo si corrigió algo o quedó algo sin comprobar.
    const conCarga = docs.map((x) => ({ id: x.id, ...x.data() })).filter((b) => PISTOLAS.has(b.coordenada));
    const sinComprobar = conCarga.filter((b) => !porDhemax.has(b.id)).map((b) => {
      const r = dh.porBus.get(b.id);
      const ppu = b.ppu ?? b.id;
      if (r?.estado === 'ambigua') return `${ppu} (${b.coordenada}: dos cargas posibles)`;
      if (r?.estado === 'probable') return `${ppu} (${b.coordenada}: el % inicial no calza del todo)`;
      if (r?.otraPistola) return `${ppu} (anotado en ${b.coordenada}; ¿fue en ${r.otraPistola.pistola}?)`;
      return `${ppu} (${b.coordenada}: el cargador no tiene una carga que calce)`;
    });
    const sinAnotar = dh.sinAnotar.map((s) => textoCarga(s, (f) => hora(f).split(' ').pop()));
    if (corregidosDh.length || sinComprobar.length || sinAnotar.length || !tallerOk) {
      await avisar(db, id,
        `Nadie cerró el turno ${nombre(turno)} del ${corta(dia)} y el robot lo cerró solo. El Power BI del SGDC no ` +
        `estaba al día (datos del ${datosSgdc ? hora(datosSgdc) : '—'}), así que lo comprobó con los cargadores ` +
        `(Dhemax): ${porDhemax.size} de ${conCarga.length} cargas confirmadas` +
        `${corregidosDh.length ? `, ${corregidosDh.length} corregidas: ${corregidosDh.join(' · ')}` : ''}.` +
        `${sinComprobar.length ? ` Sin comprobar (quedaron como las anotaron): ${sinComprobar.join(' · ')}.` : ''}` +
        `${sinAnotar.length ? ` Cargas del cargador que nadie anotó: ${sinAnotar.join(' · ')}.` : ''}` +
        `${!tallerOk ? ` El taller tampoco estaba al día (datos del ${datosTaller ? hora(datosTaller) : '—'}).` : ''}` +
        ' Revísalo en HISTORIAL DE TURNOS.');
    }
  } else if (!sgdcOk || !tallerOk) {
    const falta = [
      !sgdcOk && `el SGDC (datos del ${datosSgdc ? hora(datosSgdc) : '—'})`,
      !tallerOk && `el taller (datos del ${datosTaller ? hora(datosTaller) : '—'})`,
    ].filter(Boolean).join(' ni ');
    await avisar(db, id,
      `Nadie cerró el turno ${nombre(turno)} del ${corta(dia)} y el robot lo cerró solo, pero no pudo comprobar ` +
      `${falta} porque el Power BI no estaba al día. Quedó con lo que anotaron los bomberos: ` +
      `revísalo en HISTORIAL DE TURNOS.`);
  }
}

/// Qué cambiarle a un bus para que calce con su carga del cargador (Dhemax). Solo se llama con cargas que
/// calzan sin duda. % inicial si difiere en más de 2; % final si no calza (cerca del 100 Dhemax marca hasta 3
/// menos: ahí se deja lo anotado; si la carga sigue en curso, tampoco: su % final no es definitivo);
/// jornada por la hora de inicio si falta o es M/T/N y no calza.
export function cambiosDhemax(b, c) {
  const cambios = {};
  const poner = (k, v) => {
    if (v != null && b[k] !== v) cambios[k] = { antes: b[k] ?? null, despues: v };
  };
  if (b.pctInicial == null || Math.abs(b.pctInicial - c.si) > 2) poner('pctInicial', c.si);
  if (!c.enCurso && !finalDudoso(c) && (b.pctFinal == null || !calzaFinal(b.pctFinal, c.sf))) poner('pctFinal', c.sf);
  const j = c.ini ? jornadaDe(new Date(c.ini)) : null;
  cambiosJornada(b, j, poner);
  return cambios;
}
