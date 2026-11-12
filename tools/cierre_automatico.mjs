// Cierre automático del turno si nadie lo cerró.
//
// Corre con el robot del SGDC (a las :40). Solo actúa en el hueco entre turnos:
//   - Nocturno (termina 07:30): se cierra en la pasada de las 07:40, antes de que entre el diurno (08:30).
//   - Diurno (termina 20:00): se cierra en la pasada de las 20:40, antes de que entre el nocturno (22:00).
//
// Antes de cerrar:
//   1. Comprueba con el SGDC: corrige % inicial, % final, pistola y jornada (como "Corregir con SGDC").
//   2. Comprueba el taller: marca PT a los que mantenimiento tiene en taller y se lo quita a los que ya salieron.
//   3. Si el Power BI (SGDC o taller) no está al día, NO toca lo anotado a mano: cierra con los datos de los
//      bomberos y avisa al admin para que revise ese turno.
// Después guarda la foto del turno (igual que la app) y limpia el semáforo, manteniendo taller, vidrio,
// fuera de servicio, Pie Andino y San Carlos.
//
// Se apaga desde la app (config/cierreAuto.activo = false).

import { chile, turnoDe, cambiosSgdc, ultimoCierre, ETIQUETAS, fmt } from './auto_correccion.mjs';

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
function ventana(turno, dia) {
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

async function yaCerrado(db, turno, dia) {
  const s = await db.collection('turnos')
    .where('dia', '==', conGuiones(dia)).where('turno', '==', turno).limit(1).get();
  return !s.empty;
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
  const { turno, dia } = turnoAnterior(ahora);
  const id = `${dia}_${turno}`;
  const v = CIERRE[turno];

  if (await yaCerrado(db, turno, dia)) {
    console.log(`Cierre automático: el turno ${nombre(turno)} del ${corta(dia)} ya está cerrado.`);
    return;
  }
  // Fuera del hueco entre turnos no se cierra (borraría lo del equipo que ya entró): solo se avisa.
  const enVentana = turno === 'PM' ? hm >= v.desde && hm < v.hasta : hm >= v.desde && hm < v.hasta;
  if (!enVentana) {
    if (turno === 'PM' ? hm >= v.hasta : hm >= v.hasta || hm < 740) {
      await avisar(db, `${id}_sin_cerrar`,
        `Nadie cerró el turno ${nombre(turno)} del ${corta(dia)} y el robot no alcanzó a cerrarlo antes de que entrara ` +
        `el turno siguiente. Ciérralo tú desde CERRAR TURNO (elige ${nombre(turno)} y el día ${corta(dia)}).`);
    }
    return;
  }

  const [desde, hasta] = ventana(turno, dia);
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
  const ext = (await db.collection('externos').get()).docs;
  const batch = db.batch();
  const corregidos = [];
  const fotos = [];

  for (const d of docs) {
    const b = { ...d.data() };
    const ppu = String(b.ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cambios = sgdcOk ? cambiosSgdc(b, paraCorregir.get(ppu) ?? []) : {};
    if (tallerOk) {
      const j = cambios.jornada?.despues ?? b.jornada ?? null;
      const cargado = !!(cambios.coordenada?.despues ?? b.coordenada);
      if (enTaller.has(ppu) && !j && !cargado) cambios.jornada = { antes: b.jornada ?? null, despues: 'PT' };
      if (!enTaller.has(ppu) && j === 'PT') cambios.jornada = { antes: b.jornada ?? null, despues: null };
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
      });
      const detalle = Object.entries(cambios)
        .map(([k, x]) => `${ETIQUETAS[k] ?? k}: ${fmt(x.antes)} → ${fmt(x.despues)}`).join(' · ');
      batch.set(db.collection('actividad').doc(), {
        fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Cierre automático',
        tipo: 'Corrigió antes de cerrar', detalle, ppu,
      });
      corregidos.push(`${ppu}: ${detalle}`);
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
      kwhSgdc: kwh == null ? null : Math.round(kwh * 10) / 10,
      sohSgdc: soh,
    });

    // Limpieza para el turno siguiente (los persistentes conservan jornada y observación).
    const mantener = PERSISTENTES.has(b.jornada);
    batch.update(d.ref, {
      coordenada: null, pctInicial: null, pctFinal: null, pct1: null, pct2: null, pct3: null, kwConsumo: null,
      ...(mantener ? {} : { jornada: null, observacion: null }),
      actualizado: FieldValue.serverTimestamp(),
      actualizadoPor: 'robot',
      actualizadoPorNombre: 'Cierre automático',
    });
  }

  const vacio = (x) => x == null || String(x).trim() === '';
  const cuenta = (f) => fotos.filter(f).length;
  const [y, m, dd] = partes(dia);
  batch.set(db.collection('turnos').doc(), {
    // El nocturno queda en el día en que empezó (23:59), igual que cuando se cierra tarde en la app.
    fecha: Timestamp.fromDate(turno === 'PM' ? fechaChile(y, m, dd, 23, 59) : ahora),
    dia: conGuiones(dia),
    turno,
    cerradoPor: 'robot',
    cerradoPorNombre: 'Cierre automático',
    creado: FieldValue.serverTimestamp(),
    cerradoEn: Timestamp.fromDate(ahora),
    automatico: true,
    verificado: { sgdc: sgdcOk, taller: tallerOk },
    resumen: {
      cargadas: cuenta((b) => !vacio(b.coordenada)),
      pendientes: cuenta((b) => vacio(b.coordenada) && vacio(b.jornada)),
      taller: cuenta((b) => b.jornada === 'PT'),
      vidrio: cuenta((b) => b.jornada === 'AV'),
      kwTotal: fotos.reduce((s, b) => s + (b.kwConsumo ?? 0), 0),
      externos: ext.length,
    },
    buses: fotos,
    ...(ext.length ? { externos: ext.map((e) => ({ id: e.id, ...e.data() })) } : {}),
  });
  for (const e of ext) batch.delete(e.ref);
  batch.set(db.collection('actividad').doc(), {
    fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Cierre automático', tipo: 'Cerró turno',
    detalle: `${nombre(turno) === 'nocturno' ? 'Nocturno' : 'Diurno'} del ${corta(dia)} · nadie lo cerró · ` +
      `${corregidos.length} corregidos · limpió el semáforo`,
  });
  await batch.commit();
  console.log(`Cierre automático: turno ${nombre(turno)} del ${corta(dia)} cerrado (${corregidos.length} corregidos).`);
  for (const r of corregidos) console.log('  ', r);

  if (!sgdcOk || !tallerOk) {
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
