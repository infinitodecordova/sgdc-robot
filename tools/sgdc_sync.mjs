// Trae las cargas del día del terminal Camilo Henríquez desde el reporte público
// de Power BI (SGDC) y las deja en Firestore (colección "sgdc"), para que la app
// las compare con lo anotado en el semáforo.
//
// Uso en el PC (para probar):
//   node sgdc_sync.mjs [serviceAccount.json]      -> sube a Firestore
//   node sgdc_sync.mjs --probar                    -> solo muestra lo que trae, no sube nada
//
// En GitHub Actions la llave va en el secreto FIREBASE_SERVICE_ACCOUNT.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TERMINAL = 'Camilo Henriquez';
const aqui = dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(join(aqui, 'sgdc_consultas.json'), 'utf8'));

// ------------------------------------------------------------ Decodificar respuesta
// Power BI responde en formato "DSR" comprimido: filas que repiten valores (R),
// nulos (Ø) y diccionarios de textos (ValueDicts).
export function decodificar(resp) {
  const data = resp.results[0].result.data;
  const nombres = Object.fromEntries(data.descriptor.Select.map((s) => [s.Value, s.Name]));
  const ds = data.dsr.DS[0];
  const dicts = ds.ValueDicts ?? {};
  let dm = [];
  for (const ph of ds.PH) for (const [k, v] of Object.entries(ph)) if (k.startsWith('DM')) dm = v;
  let schema = null;
  let previa = null;
  const filas = [];
  for (const fila of dm) {
    if (fila.S) schema = fila.S;
    const C = fila.C ?? [];
    const R = fila.R ?? 0;
    const Z = fila['Ø'] ?? 0;
    let ci = 0;
    const out = {};
    schema.forEach((col, i) => {
      const nombre = nombres[col.N] ?? col.N;
      let v;
      if (fila[col.N] !== undefined) v = fila[col.N]; // valores sueltos (medidas)
      else if ((R >> i) & 1) v = previa[nombre];
      else if ((Z >> i) & 1) v = null;
      else {
        v = C[ci++];
        if (col.DN && typeof v === 'number') v = dicts[col.DN][v];
      }
      out[nombre] = v;
    });
    previa = out;
    filas.push(out);
  }
  return { filas, quedanMas: !!ds.RT };
}

// ------------------------------------------------------------ Fechas
// Power BI entrega la hora "de reloj" de Chile como si fuera UTC: la pasamos a hora real.
function desfase(t) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Santiago', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}
function horaReal(ms) {
  if (ms == null || typeof ms !== 'number') return null;
  let t = ms - desfase(ms);
  t = ms - desfase(t);
  return new Date(t);
}
/// Hora real de "datos del reporte" del Power BI (viene como número o como texto "2026-11-12 06:13:11").
function horaReporte(v) {
  if (typeof v === 'number') return horaReal(v);
  const m = String(v ?? '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return horaReal(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
}
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

// ------------------------------------------------------------ Consultar Power BI
async function consultar(cuerpo, origen = C) {
  const r = await fetch(origen.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      'X-PowerBI-ResourceKey': origen.resourceKey,
      Origin: 'https://app.powerbi.com',
      Referer: 'https://app.powerbi.com/',
      ActivityId: crypto.randomUUID(),
      RequestId: crypto.randomUUID(),
    },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`Power BI respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/// La misma consulta de la tabla del reporte, pero solo para nuestro terminal.
function consultaCargas() {
  const b = structuredClone(C.cargas);
  const q = b.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
  q.Where = [
    ...(q.Where ?? []),
    {
      Condition: {
        In: {
          Expressions: [{ Column: { Expression: { SourceRef: { Source: 'c' } }, Property: 'terminal' } }],
          Values: [[{ Literal: { Value: `'${TERMINAL}'` } }]],
        },
      },
    },
  ];
  return b;
}

export function aCarga(f) {
  const ppuSgdc = String(f['cargas_hist.ppu'] ?? '').trim().toUpperCase();
  const inicio = horaReal(f['cargas_hist.hr_inicio_carga']);
  const reserva = horaReal(f['cargas_hist.hr_reserva']);
  const ppu = ppuSgdc.replace(/[^A-Z0-9]/g, ''); // igual que en el semáforo: SRPJ80
  return {
    // Una carga = un bus + su hora de inicio. (El número de secuencia del SGDC cambia
    // de una hora a otra, y con él la misma carga quedaba guardada varias veces.)
    id: `${ppu}_${(inicio ?? reserva)?.getTime() ?? String(f['cargas_hist.secuencia_id'])}`,
    secuencia: String(f['cargas_hist.secuencia_id'] ?? ''),
    ppu,
    ppuSgdc,
    terminal: f['cargas_hist.terminal'] ?? null,
    pistola: f['cargas_hist.pistola'] ?? null,
    reserva,
    inicio,
    fin: horaReal(f['cargas_hist.hr_fin_carga']),
    cuando: inicio ?? reserva, // para buscar por turno
    socInicio: num(f['Sum(cargas_hist.soc_inicio)']),
    socFin: num(f['Sum(cargas_hist.soc_fin)']),
    soh: num(f['Sum(cargas_hist.soh)']),
    kwh: num(f['Sum(cargas_hist.kwh_carga)']),
    minutos: num(f['Sum(cargas_hist.tiempo_carga)']),
    estado: f['cargas_hist.Estado carga'] ?? null,
  };
}

let db = null; // Firestore, si ya se conectó (para anotar errores)

async function conectarFirestore(llave) {
  const { default: admin } = await import('firebase-admin');
  const credencial = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : JSON.parse(readFileSync(llave ?? 'serviceAccount.json', 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(credencial) });
  db = admin.firestore();
  return admin;
}

/// Deja el error en la colección "errores" para que el admin lo vea en la app.
async function anotarError(e, origen = 'robot SGDC') {
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const ahora = new Date();
  const dia = ahora.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).replace(/-/g, '');
  const mensaje = String(e?.message ?? e).slice(0, 1500);
  let h = 0x811c9dc5;
  for (const c of mensaje.split('\n')[0]) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  await db.collection('errores').doc(`${dia}_robot_${h.toString(16)}`).set({
    origen,
    donde: 'GitHub Actions · sgdc-robot',
    mensaje,
    stack: String(e?.stack ?? '').slice(0, 4000),
    plataforma: 'GitHub',
    ultima: FieldValue.serverTimestamp(),
    ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'),
    veces: FieldValue.increment(1),
    resuelto: false,
  }, { merge: true });
}


// ------------------------------------------------------------ Resumen mensual del SGDC
// sgdcMes/AAAA-MM = { datos: '{"SRPJ80_1731...": [ppu, pistola, inicio, fin, cuando, socI, socF, soh, kwh, estado, min]}' }
// Va como texto JSON porque así no gasta índices de Firestore y cabe un mes completo (<1 MB).

const msDe = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : v ?? null);

/// "2026-11" según la hora de Chile.
function claveMes(d) {
  const f = d instanceof Date ? d : d?.toDate?.() ?? new Date();
  return f.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).slice(0, 7);
}

function filaMes(c) {
  return [c.ppu ?? null, c.pistola ?? null, msDe(c.inicio), msDe(c.fin), msDe(c.cuando),
    c.socInicio ?? null, c.socFin ?? null, c.soh ?? null, c.kwh ?? null, c.estado ?? null, c.minutos ?? null];
}

/// Lee (o arma por primera vez) el resumen de cada mes que aparece en las cargas.
async function leerMeses(db, cargas) {
  const meses = new Map();
  for (const k of new Set(cargas.map((c) => claveMes(c.cuando)))) {
    const g = await db.doc(`sgdcMes/${k}`).get();
    if (g.exists) {
      let datos = {};
      try { datos = JSON.parse(g.data().datos ?? '{}'); } catch {}
      meses.set(k, { datos, cambio: false });
      continue;
    }
    // Primera vez: se arma con lo que ya está guardado de ese mes (una sola vez por mes).
    const [y, m] = k.split('-').map(Number);
    const desde = new Date(Date.UTC(y, m - 1, 1, 3)); // 00:00 de Chile aprox.; el filtro fino es claveMes
    const hasta = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 6));
    const s = await db.collection('sgdc').where('cuando', '>=', desde).where('cuando', '<', hasta).get();
    const datos = {};
    for (const d of s.docs) {
      const c = d.data();
      if (claveMes(c.cuando) === k) datos[d.id] = filaMes(c);
    }
    console.log(`SGDC: resumen de ${k} armado por primera vez con ${Object.keys(datos).length} cargas.`);
    meses.set(k, { datos, cambio: true });
  }
  return meses;
}

const ppuClave = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function sincronizarSgdc(probar) {
  const resp = await consultar(consultaCargas());
  const { filas, quedanMas } = decodificar(resp);
  const cargas = filas.map(aCarga).filter((c) => c.id && c.ppu && c.terminal === TERMINAL);
  if (quedanMas) console.warn('Ojo: Power BI dice que hay más filas que las 500 que entrega.');

  let actualizado = null;
  try {
    const u = decodificar(await consultar(C.actualizacion));
    actualizado = Object.values(u.filas[0] ?? {})[0] ?? null;
  } catch (e) {
    console.warn('No pude leer la hora de actualización del reporte:', e.message);
  }

  console.log(`SGDC: ${cargas.length} cargas de ${TERMINAL} (datos del reporte: ${actualizado ?? '?'})`);
  if (probar) {
    for (const c of cargas.slice(0, 15)) {
      console.log(c.ppuSgdc, c.pistola, c.inicio?.toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
        `${c.socInicio}% → ${c.socFin}%`, `${c.kwh} kWh`, c.estado);
    }
    return;
  }

  const { FieldValue, FieldPath } = await import('firebase-admin/firestore');
  const ahora = FieldValue.serverTimestamp();

  // Solo se escriben las cargas nuevas o que cambiaron (ahorra escrituras del plan gratis).
  // Para saber cuáles cambiaron NO se relee cada carga (eran cientos de lecturas por hora):
  // se compara contra el resumen del mes (sgdcMes/AAAA-MM), que es UN documento.
  const refs = cargas.map((c) => db.collection('sgdc').doc(c.id.replace(/\//g, '_')));
  const meses = await leerMeses(db, cargas);

  let batch = db.batch();
  let n = 0;
  cargas.forEach((c, i) => {
    const mes = meses.get(claveMes(c.cuando));
    const nueva = filaMes(c);
    const antes = mes?.datos[refs[i].id];
    if (antes && JSON.stringify(antes) === JSON.stringify(nueva)) return;
    if (mes) {
      mes.datos[refs[i].id] = nueva;
      mes.cambio = true;
    }
    const { id, ...resto } = c;
    batch.set(refs[i], { ...resto, actualizado: ahora }, { merge: true });
    n++;
    // El SoH de cada carga terminada queda como lectura en el historial de SoH del bus.
    if (c.estado === 'Finalizada' && c.soh != null && c.soh > 0 && c.soh <= 100) {
      batch.set(db.collection('soh').doc(`sgdc_${refs[i].id}`), {
        ppu: c.ppu,
        valor: c.soh,
        fecha: c.fin ?? c.inicio ?? new Date(),
        nombre: 'SGDC',
        origen: 'sgdc',
      });
    }
  });
  // Resumen liviano en UN documento que ven todos: sirve para avisar en el semáforo
  // que un bus ya presenta carga en el SGDC antes de cargarlo de nuevo.
  const resumen = {};
  for (const c of cargas) {
    (resumen[c.ppu] ??= []).push({
      inicio: c.inicio ?? c.reserva ?? null,
      fin: c.fin ?? null,
      pistola: c.pistola ?? null,
      socInicio: c.socInicio ?? null,
      socFin: c.socFin ?? null,
      estado: c.estado ?? null,
      kwh: c.kwh ?? null,
      soh: c.soh ?? null,
    });
  }
  batch.set(db.doc('sgdcResumen/hoy'), { cargas: resumen, datosReporte: actualizado, actualizado: ahora });
  // Resumen del mes (lo usan Estadísticas: 1 lectura en vez de miles).
  for (const [k, m] of meses) {
    if (m.cambio) batch.set(db.doc(`sgdcMes/${k}`), { datos: JSON.stringify(m.datos), n: Object.keys(m.datos).length, actualizado: ahora });
  }
  batch.set(db.doc('config/sgdc'), {
    ultimaSync: ahora,
    datosReporte: actualizado,
    cargasHoy: cargas.length,
  }, { merge: true });
  await batch.commit();
  console.log(`SGDC: ${n} cargas nuevas o cambiadas guardadas (de ${cargas.length}).`);

  // La corrección automática corre en main(), DESPUÉS del cierre automático.
  return { cargas, datos: horaReporte(actualizado) };

  // Limpieza: borra las cargas guardadas con el identificador antiguo (quedaban repetidas).
  let borradas = 0;
  for (let i = 0; i < 10; i++) {
    const viejas = (await db.collection('sgdc').orderBy(FieldPath.documentId()).startAt('2').endAt('2\uf8ff').limit(400).get())
      .docs.filter((d) => /^\d{4}-\d{2}-\d{2}_/.test(d.id));
    if (!viejas.length) break;
    const b = db.batch();
    for (const d of viejas) b.delete(d.ref);
    await b.commit();
    borradas += viejas.length;
  }
  if (borradas) console.log(`SGDC: ${borradas} cargas repetidas (formato antiguo) borradas.`);
}

/// PPU del semáforo. Se guarda en un solo documento y se rehace una vez al día
/// (así cada pasada lee 1 documento y no los 48 buses).
async function obtenerFlota() {
  if (!db) return null;
  const ref = db.doc('privado/flota');
  const g = await ref.get();
  const edad = Date.now() - (g.data()?.fecha?.toMillis?.() ?? 0);
  if (g.exists && Array.isArray(g.data().ppus) && edad < 24 * 3600 * 1000) return new Set(g.data().ppus);
  const s = await db.collection('semaforoch').get();
  const flota = new Set(s.docs.map((d) => ppuClave(d.data().ppu ?? d.id)));
  const { Timestamp } = await import('firebase-admin/firestore');
  await ref.set({ ppus: [...flota], fecha: Timestamp.now() });
  return flota;
}

// ------------------------------------------------------------ Buses en taller
// Reporte público "Estado buses taller" (STP operaciones). Solo se guardan los buses
// del semáforo que están No Operativos, todos en UN documento (taller/flota).
async function sincronizarTaller(probar) {
  const T = JSON.parse(readFileSync(join(aqui, 'taller_consultas.json'), 'utf8'));
  const cuerpo = structuredClone(T.buses);
  const q = cuerpo.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
  q.Where = [
    ...(q.Where ?? []),
    {
      Condition: {
        In: {
          Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Terminal v2' } }],
          Values: [[{ Literal: { Value: "'Camilo henriquez'" } }]],
        },
      },
    },
  ];
  const { filas, quedanMas } = decodificar(await consultar(cuerpo, T));
  if (quedanMas) console.warn('Ojo: el reporte de taller dice que hay más filas que las 500 que entrega.');

  let datos = null;
  try {
    const u = decodificar(await consultar(T.actualizacion, T));
    datos = horaReal(Object.values(u.filas[0] ?? {})[0]);
  } catch (e) {
    console.warn('No pude leer la hora de actualización del taller:', e.message);
  }

  const flota = await obtenerFlota();
  const buses = {};
  for (const f of filas) {
    const ppu = ppuClave(f['stp_portal buses_inventario.PPU1']);
    const estado = f['Base_taller.Estado'];
    if (!ppu || !estado || estado === 'Operativo') continue;
    if (flota && !flota.has(ppu)) continue; // solo las patentes del semáforo
    buses[ppu] = {
      estado,
      detalle: f['idpanneRutaEstado.Detalle'] ?? null,
      ingreso: horaReal(f['Base_taller.Fecha_I']),
    };
  }
  const n = Object.keys(buses).length;
  console.log(`Taller: ${filas.length} buses del terminal en el reporte, ${n} del semáforo en taller ` +
    `(datos: ${datos?.toLocaleString('es-CL', { timeZone: 'America/Santiago' }) ?? '?'})`);
  if (probar) {
    for (const [ppu, b] of Object.entries(buses)) {
      console.log(' ', ppu, b.estado, '·', b.detalle, '· ingresó',
        b.ingreso?.toLocaleString('es-CL', { timeZone: 'America/Santiago' }));
    }
    return;
  }
  const { FieldValue } = await import('firebase-admin/firestore');
  await db.doc('taller/flota').set({ buses, datos, actualizado: FieldValue.serverTimestamp() });
  console.log(`Taller: ${n} buses guardados en Firestore.`);
}

/// Una pasada: SGDC y/o taller y, si se trajo el SGDC, cierre automático y corrección (en ese orden).
/// Devuelve { fallo, sgdc } (sgdc = { cargas, datos } o null).
async function pasada({ hacerSgdc, hacerTaller, probar = false }) {
  let fallo = false;
  let sgdc = null;
  if (hacerSgdc) {
    try {
      sgdc = await sincronizarSgdc(probar);
    } catch (e) {
      fallo = true;
      console.error('Falló el SGDC:', e.message);
      await anotarError(e, 'robot SGDC').catch(() => {});
    }
  }
  if (hacerTaller) {
    try {
      await sincronizarTaller(probar);
    } catch (e) {
      fallo = true;
      console.error('Falló el taller:', e.message);
      await anotarError(e, 'robot taller').catch(() => {});
    }
  }
  // Cierre automático del turno si nadie lo cerró (después del SGDC y el taller, con los datos frescos).
  if (hacerSgdc && !probar) fallo = (await cerrarSiFalta(sgdc)) || fallo;
  // Corrección automática del turno en curso (si el admin la dejó activada). Va DESPUÉS del cierre:
  // así el cierre no se lleva a su foto cargas del turno nuevo, ni las borra al limpiar.
  if (sgdc && !probar) fallo = (await corregir(sgdc)) || fallo;
  return { fallo, sgdc };
}

/// Corrección automática con las cargas ya traídas. Devuelve true si falló.
async function corregir(sgdc) {
  try {
    const { autoCorregir } = await import('./auto_correccion.mjs');
    await autoCorregir(db, sgdc.cargas);
    return false;
  } catch (e) {
    console.error('Falló la corrección automática:', e.message);
    await anotarError(e, 'robot SGDC').catch(() => {});
    return true;
  }
}

/// Cierre automático con las cargas ya traídas. Devuelve true si falló.
async function cerrarSiFalta(sgdc) {
  try {
    const { cierreAutomatico } = await import('./cierre_automatico.mjs');
    await cierreAutomatico(db, sgdc?.cargas ?? null, sgdc?.datos ?? null);
    return false;
  } catch (e) {
    console.error('Falló el cierre automático:', e.message);
    await anotarError(e, 'cierre automático').catch(() => {});
    return true;
  }
}

// ------------------------------------------------------------ Vigilar los Power BI
// Los dos Power BI (SGDC y taller) se actualizan ~1 vez por hora (~:25–:32). En vez de esperar un cron
// que GitHub atrasa o se salta, cada 2 min se consulta SOLO la hora de actualización de cada reporte
// (consulta liviana) y, apenas cambia, se trae ese reporte. A las :40 de cada hora se hace igual la
// pasada de siempre (cierre automático y corrección), con lo que ya está en memoria si es reciente.

/// Hora "datos del reporte" del SGDC, tal como viene (para comparar con config/sgdc.datosReporte).
async function horaDatosSgdc() {
  const u = decodificar(await consultar(C.actualizacion));
  return Object.values(u.filas[0] ?? {})[0] ?? null;
}

/// Hora de los datos del reporte de taller (para comparar con taller/flota.datos).
async function horaDatosTaller() {
  const T = JSON.parse(readFileSync(join(aqui, 'taller_consultas.json'), 'utf8'));
  const u = decodificar(await consultar(T.actualizacion, T));
  return horaReal(Object.values(u.filas[0] ?? {})[0]);
}

let minutoForzado = null; // solo pruebas

/// Minuto de la hora de Chile y una clave por hora ("2026111320").
function horaChileAhora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const minuto = minutoForzado ?? Number(p.minute);
  return { minuto, clave: `${p.year}${p.month}${p.day}${p.hour}`, texto: `${p.hour}:${String(minuto).padStart(2, '0')}` };
}

async function vigilar({ minutos = 55, cadaMin = 2, escala = 1 } = {}) {
  const fin = Date.now() + minutos * 60000 * escala;
  let ultSgdc = (await db.doc('config/sgdc').get()).data()?.datosReporte ?? null;
  let ultTaller = (await db.doc('taller/flota').get()).data()?.datos?.toMillis?.() ?? null;
  let sgdc = null; // última pasada del SGDC (cargas en memoria)
  let horaSync = 0;
  let tickHecho = null; // hora en que ya se hizo la pasada de las :40
  let fallosSeguidos = 0;
  let fallo = false;
  console.log(`Vigilando los Power BI cada ${cadaMin} min (SGDC: ${ultSgdc ?? '—'}).`);
  while (Date.now() < fin) {
    const t0 = Date.now();
    const h = horaChileAhora();
    const hizo = [];
    try {
      const hs = await horaDatosSgdc();
      if (hs != null && JSON.stringify(hs) !== JSON.stringify(ultSgdc)) {
        const r = await pasada({ hacerSgdc: true, hacerTaller: false });
        fallo = r.fallo || fallo;
        if (r.sgdc) {
          sgdc = r.sgdc;
          horaSync = Date.now();
          ultSgdc = hs;
          hizo.push(`SGDC nuevo (datos ${hs})`);
        }
      }
      const ht = await horaDatosTaller();
      if (ht && ht.getTime() !== ultTaller) {
        await sincronizarTaller(false);
        ultTaller = ht.getTime();
        hizo.push(`taller nuevo (datos ${ht.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago' })})`);
      }
      fallosSeguidos = 0;
    } catch (e) {
      fallosSeguidos++;
      console.warn(`[${h.texto}] No se pudo revisar el Power BI (${fallosSeguidos} seguidas):`, e.message);
      if (fallosSeguidos === 3) await anotarError(e, 'robot SGDC').catch(() => {});
    }
    // La pasada de las :40 (como el cron de siempre): cierre automático y corrección.
    if (h.minuto >= 40 && tickHecho !== h.clave) {
      tickHecho = h.clave;
      if (sgdc && Date.now() - horaSync < 25 * 60000 * escala) {
        fallo = (await cerrarSiFalta(sgdc)) || fallo;
        fallo = (await corregir(sgdc)) || fallo;
        hizo.push('pasada de las :40 (con el SGDC recién traído)');
      } else {
        const r = await pasada({ hacerSgdc: true, hacerTaller: true });
        fallo = r.fallo || fallo;
        if (r.sgdc) {
          sgdc = r.sgdc;
          horaSync = Date.now();
        }
        hizo.push('pasada de las :40 (SGDC y taller completos)');
      }
    }
    console.log(`[${h.texto}] ${hizo.length ? hizo.join(' · ') : 'sin datos nuevos'}`);
    const espera = cadaMin * 60000 * escala - (Date.now() - t0);
    if (Date.now() + espera >= fin) break;
    await new Promise((ok) => setTimeout(ok, Math.max(0, espera)));
  }
  console.log('Vigilancia terminada.');
  return fallo;
}

/// Solo para las pruebas simuladas (no se usa en el robot).
export const _paraPruebas = { vigilar, usarDb: (x) => { db = x; }, minuto: (m) => { minutoForzado = m; } };

async function main() {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const conValor = new Set(['--minutos']);
  const llave = args.find((a, i) => !a.startsWith('--') && !conValor.has(args[i - 1]));
  const solo = (x) => args.includes(`--solo-${x}`);
  const alguno = solo('sgdc') || solo('digicar') || solo('taller');
  const hacerSgdc = alguno ? solo('sgdc') : true;
  const hacerTaller = alguno ? solo('taller') : true;
  const hacerDigicar = alguno ? solo('digicar') : !args.includes('--sin-digicar');
  if (!probar) await conectarFirestore(llave);

  // --vigilar: ~55 min revisando los Power BI (workflow sgdc.yml); termina con error si algo falló.
  if (args.includes('--vigilar') && !probar) {
    const i = args.indexOf('--minutos');
    const minutos = i >= 0 ? Math.max(1, Math.min(58, Number(args[i + 1]) || 55)) : 55;
    if (await vigilar({ minutos })) process.exit(1);
    return;
  }

  let { fallo } = await pasada({ hacerSgdc, hacerTaller, probar });
  if (hacerDigicar) {
    try {
      const flota = await obtenerFlota();
      const { sincronizarDigicar, pedirCredencialesSiFaltan } = await import('./digicar_sync.mjs');
      if (probar) await pedirCredencialesSiFaltan();
      await sincronizarDigicar({ db: probar ? null : db, dbToken: db, probar, flota });
    } catch (e) {
      if (!e.soloAviso) fallo = true;
      console.error(e.soloAviso ? 'Aviso digiCAR:' : 'Falló digiCAR:', e.message);
      await anotarError(e, 'robot digiCAR').catch(() => {});
    }
  }
  if (fallo) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (e) => {
    console.error('Falló la sincronización:', e.message);
    try {
      await anotarError(e, 'robot');
    } catch (x) {
      console.error('Tampoco pude anotar el error en Firestore:', x.message);
    }
    process.exit(1);
  });
}
