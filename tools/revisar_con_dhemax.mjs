// Revisión hacia atrás de los turnos cerrados con los cargadores (Dhemax) como árbitro.
// Por defecto SOLO LEE: muestra por turno cuántas cosas acusaba la revisión solo con el SGDC y cuántas
// quedan con los cargadores, y el detalle. Lo corre el usuario en su PC.
//
//   node revisar_con_dhemax.mjs --desde 2026-11-01 --hasta 2026-11-23            con la API (pide usuario y clave)
//   node revisar_con_dhemax.mjs --desde 2026-11-19 --excel ~/Descargas            con los Excel de Dhemax
//   node revisar_con_dhemax.mjs ... --detalle                                     lista cada problema
//   node revisar_con_dhemax.mjs ... --guardar                                     guarda dhemaxTurnos/<turno> y
//                                                                                 turnos/<turno>.verificacion
//                                                                                 (solo con la API: lo usa la app)
// También corre en GitHub Actions con los secretos del repo (workflow revisar_dhemax.yml, a mano).
// Lecturas de Firestore: los turnos del rango + el resumen del mes del SGDC (sgdcMes, 1 por mes).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import admin from 'firebase-admin';
import { ventana } from './cierre_automatico.mjs';
import { cargasDhemaxEntre, emparejar, paraFirestore } from './dhemax_cruce.mjs';
import { pistolaDe } from './dhemax_api.mjs';
import { problemasTurno } from './revision_turnos.mjs';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
const DESDE = opt('--desde') ?? `${hoy.slice(0, 8)}01`;
const HASTA = opt('--hasta') ?? hoy;
const EXCEL = opt('--excel');
const DETALLE = args.includes('--detalle');
const GUARDAR = args.includes('--guardar');

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

// En GitHub Actions la llave llega en FIREBASE_SERVICE_ACCOUNT (workflow revisar_dhemax.yml); en el PC, el archivo.
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ??
    readFileSync(new URL('./serviceAccount.json', import.meta.url), 'utf8'))),
});
const db = admin.firestore();

// ------------------------------------------------------------------ Dhemax (API o Excel)

let deExcel = null;
if (EXCEL) {
  const { default: XLSX } = await import('xlsx');
  deExcel = [];
  for (const f of readdirSync(EXCEL).filter((x) => /^Informe_Cargas_Cargador.*\.xlsx$/i.test(x))) {
    const filas = XLSX.utils.sheet_to_json(XLSX.readFile(join(EXCEL, f)).Sheets.informe, { header: 1, raw: false });
    for (const r of filas.slice(4)) {
      if (!r[0] || !r[3]) continue;
      const ini = new Date(`${r[3].replace(' ', 'T')}-03:00`); // el Excel viene en hora de Chile (verano)
      deExcel.push({
        tr: `${r[0]}-${r[1]}-${ini.getTime()}`, cargador: r[0], manguera: +r[1], pistola: pistolaDe(r[0], r[1]),
        inicio: ini, fin: new Date(`${r[4].replace(' ', 'T')}-03:00`),
        socIni: +r[6], socFin: +r[7], kwh: +String(r[8]).replace(',', '.'),
      });
    }
  }
  console.log(`Dhemax desde ${deExcel.length} filas de Excel (${EXCEL}).`);
  if (GUARDAR) {
    console.log('--guardar solo con la API (los Excel no traen el número de transacción). No se guardará nada.');
  }
} else if (!(process.env.DHEMAX_USUARIO && process.env.DHEMAX_CLAVE)) {
  if (!process.stdin.isTTY) {
    console.error('Faltan DHEMAX_USUARIO / DHEMAX_CLAVE y no hay terminal para preguntarlos.');
    process.exit(1);
  }
  process.env.DHEMAX_USUARIO = await preguntar('Usuario (correo) de Dhemax: ');
  process.env.DHEMAX_CLAVE = await preguntar('Contraseña de Dhemax (no se ve): ', true);
}
const dhemaxEntre = async (desde, hasta) => (deExcel
  ? deExcel.filter((c) => c.inicio >= desde && c.inicio < hasta && c.pistola)
  : cargasDhemaxEntre(desde, hasta));

// ------------------------------------------------------------------ SGDC (resumen del mes)

const meses = new Map();
async function sgdcMes(clave) {
  if (!meses.has(clave)) {
    const d = (await db.doc(`sgdcMes/${clave}`).get()).data();
    const datos = d?.datos ? JSON.parse(d.datos) : {};
    // [ppu, pistola, inicio, fin, cuando, socI, socF, soh, kwh, estado, min]
    meses.set(clave, Object.values(datos).map((f) => ({
      ppu: f[0], pistola: f[1], inicio: f[2] ? new Date(f[2]) : null, fin: f[3] ? new Date(f[3]) : null,
      socInicio: f[5], socFin: f[6], soh: f[7], kwh: f[8], estado: f[9], minutos: f[10], terminal: 'Camilo Henriquez',
    })));
  }
  return meses.get(clave);
}

// ------------------------------------------------------------------ revisión

const turnos = (await db.collection('turnos').where('dia', '>=', DESDE).where('dia', '<=', HASTA).get()).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((t) => t.anulado !== true && ['AM', 'PM'].includes(t.turno))
  .sort((a, b) => `${a.dia}${a.turno}`.localeCompare(`${b.dia}${b.turno}`));
console.log(`${turnos.length} turnos cerrados del ${DESDE} al ${HASTA}.\n`);

const tot = { antes: 0, despues: 0, confirmadas: 0, sinAnotar: 0, ambiguas: 0, cargador: 0, nada: 0 };
let guardados = 0;
for (const t of turnos) {
  const dia = t.dia.replace(/-/g, '');
  const [desde, hasta] = ventana(t.turno, dia);
  const titulo = `${t.turno === 'AM' ? 'diurno  ' : 'nocturno'} ${t.dia.slice(8)}/${t.dia.slice(5, 7)}`;
  const claves = new Set([desde, hasta].map((f) => f.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).slice(0, 7)));
  const sgdc = (await Promise.all([...claves].map(sgdcMes))).flat()
    .filter((c) => c.inicio && c.inicio >= desde && c.inicio < hasta);
  let dh = null;
  let nDh = 0;
  try {
    const l = await dhemaxEntre(desde, hasta);
    nDh = l.length;
    if (l.length) dh = emparejar(t.buses ?? [], l, sgdc.filter((c) => c.pistola));
  } catch (e) {
    console.log(`${titulo}: Dhemax falló (${e.message})`);
  }
  const antes = problemasTurno(t, sgdc);
  const info = {};
  const despues = problemasTurno(t, sgdc, [], [], dh, info);
  tot.antes += antes.length;
  tot.despues += despues.length;
  tot.confirmadas += info.confirmadas.length;
  for (const p of despues) {
    if (p.startsWith('Cargador ')) tot.sinAnotar++;
    else if (/podrían ser suyas/.test(p)) tot.ambiguas++;
    else if (/el cargador dice/.test(p)) tot.cargador++;
    else if (/ni el SGDC ni el cargador/.test(p)) tot.nada++;
  }
  console.log(`${titulo} · cerró ${(t.cerradoPorNombre ?? '—').padEnd(18)} · SGDC ${String(sgdc.length).padStart(2)} · ` +
    `cargadores ${String(nDh).padStart(2)}${dh ? '' : ' (sin cruce)'} · antes ${String(antes.length).padStart(2)} → ` +
    `ahora ${String(despues.length).padStart(2)} · confirmadas ${info.confirmadas.length}`);
  if (DETALLE) for (const p of despues) console.log(`      • ${p}`);
  if (DETALLE) for (const p of info.erroresSgdc) console.log(`      (error del SGDC, no cuenta) ${p}`);
  if (GUARDAR && !EXCEL && dh) {
    await db.doc(`dhemaxTurnos/${t.id}`).set({
      turnoId: t.id, dia: t.dia, turno: t.turno, calculado: admin.firestore.FieldValue.serverTimestamp(), ...paraFirestore(dh),
    });
    guardados++;
  }
  // Resultado en el turno (✓✓ / ✓ / ⚠ N en el historial de la app). Con datos del SGDC o de los cargadores.
  if (GUARDAR && !EXCEL && (dh || sgdc.length)) {
    await db.doc(`turnos/${t.id}`).update({
      verificacion: {
        sgdc: sgdc.length > 0, cargadores: !!dh, problemas: despues.length, confirmadas: info.confirmadas.length,
        revisado: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  }
}
console.log(`\nTotal: la revisión solo con el SGDC acusaba ${tot.antes}; con los cargadores quedan ${tot.despues}.`);
console.log(`  ${tot.confirmadas} cargas que el SGDC no tenía quedaron confirmadas con el cargador.`);
console.log(`  De lo que queda: ${tot.cargador} % final distinto al del cargador · ${tot.nada} sin carga en el SGDC ni en el cargador · ` +
  `${tot.ambiguas} con dos cargas posibles · ${tot.sinAnotar} cargas del cargador que nadie anotó · ` +
  `${tot.despues - tot.cargador - tot.nada - tot.ambiguas - tot.sinAnotar} otras (patente, NI, SGDC).`);
if (GUARDAR) console.log(`Guardados ${guardados} cruces en dhemaxTurnos.`);
process.exit(0);
