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
  return {
    id: String(f['cargas_hist.secuencia_id']),
    ppu: ppuSgdc.replace(/[^A-Z0-9]/g, ''), // igual que en el semáforo: SRPJ80
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

  const { FieldValue } = await import('firebase-admin/firestore');
  const ahora = FieldValue.serverTimestamp();

  // Solo se escriben las cargas nuevas o que cambiaron (ahorra escrituras del plan gratis).
  const refs = cargas.map((c) => db.collection('sgdc').doc(c.id.replace(/\//g, '_')));
  const previos = refs.length ? await db.getAll(...refs) : [];
  const ms = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : v ?? null);
  const igual = (a, b) => ['socInicio', 'socFin', 'kwh', 'estado', 'pistola', 'soh', 'minutos']
    .every((k) => (a[k] ?? null) === (b[k] ?? null)) && ms(a.fin) === ms(b.fin) && ms(a.inicio) === ms(b.inicio);

  let batch = db.batch();
  let n = 0;
  cargas.forEach((c, i) => {
    const { id, ...resto } = c;
    const antes = previos[i]?.exists ? previos[i].data() : null;
    if (antes && igual(antes, resto)) return;
    batch.set(refs[i], { ...resto, actualizado: ahora }, { merge: true });
    n++;
  });
  batch.set(db.doc('config/sgdc'), {
    ultimaSync: ahora,
    datosReporte: actualizado,
    cargasHoy: cargas.length,
  }, { merge: true });
  await batch.commit();
  console.log(`SGDC: ${n} cargas nuevas o cambiadas guardadas (de ${cargas.length}).`);
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

async function main() {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const llave = args.find((a) => !a.startsWith('--'));
  const solo = (x) => args.includes(`--solo-${x}`);
  const alguno = solo('sgdc') || solo('digicar') || solo('taller');
  const hacerSgdc = alguno ? solo('sgdc') : true;
  const hacerTaller = alguno ? solo('taller') : true;
  const hacerDigicar = alguno ? solo('digicar') : !args.includes('--sin-digicar');
  if (!probar) await conectarFirestore(llave);

  let fallo = false;
  if (hacerSgdc) {
    try {
      await sincronizarSgdc(probar);
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
