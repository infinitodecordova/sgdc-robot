// Etapa 2 del "Estado del bus": incidencias de carga que el robot ve en los cargadores (Dhemax) y PROPONE en la
// tarjeta del bus; el bombero las anota con un toque o las descarta (campo `propuesta` del bus en semaforoch).
//   - Cambio de pistola: su carga siguió en otra pistola (dhemax_cruce: continuaEn) → CAMBIO + pistolaNueva/pctCambio.
//   - Carga cortada: se cortó y se reconectó en la misma pistola (dhemax_cruce: corte) → CORTE.
//   - Carga cortada sin reconexión (26-11, caso 23-11 PM: 4 buses cortaron entre 23:15 y 23:32, SRPJ80 y SRRX41 en
//     76 %): la carga del turno terminó (Dhemax, ya no en curso) bajo meta − margen según la hora de fin y no
//     volvió a cargar → CORTE. Solo con Dhemax (no suma lecturas: el SGDC no se pide aquí).
// Solo turno en curso, solo buses con pistola, sin incidencia anotada y si la propuesta no se descartó antes
// (`propuestaDescartada` = clave). Corre con el vigilante del SGDC (una vez por hora): lee los 48 buses y Dhemax;
// escribe solo cuando hay una propuesta nueva.
import { emparejar, cargasDhemaxEntre, finalDudoso, hayDhemax, marcarEnCurso } from './dhemax_cruce.mjs';
import { chile, turnoACorregir } from './auto_correccion.mjs';
import { ventana } from './cierre_automatico.mjs';

const hm = (ms) => new Date(ms).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const MIN = 60000;
const VUELVE_MIN = 90; // otra carga que parte dentro de esto tras el fin y en el mismo % = el bus volvió a cargar
const VUELVE_PCT = 3;

/// Meta de SoC y margen de aviso según la hora de Chile en formato hmm (730 = 07:30), desde el 26-11 (decisión del
/// usuario, con datos: la operación carga a 95 todo el día): 07:30–20:00 → meta 95, margen 5 (aviso bajo 90);
/// 20:00–07:30 → meta 100, margen 3 (aviso bajo 97). Misma regla que lib/data/meta_soc.dart.
export function metaYMargen(hmm) {
  const dia = hmm >= 730 && hmm < 2000;
  return dia ? { meta: 95, margen: 5 } : { meta: 100, margen: 3 };
}

/// ¿La carga (de Dhemax, ya resumida por el cruce) quedó cortada bajo meta − margen y el bus no volvió a cargar?
/// [todas] = cargas crudas de Dhemax del turno ({ inicio, socIni, tr }). Cerca del 100 % Dhemax lee hasta 3 puntos
/// menos que el real: desde 94 se suman 3 antes de comparar. Devuelve { sf, fin, meta } o null.
export function cargaCortada(c, todas = [], hmDe = (fin) => chile(new Date(fin)).hm) {
  if (!c || c.enCurso || c.continuaEn || c.corte || c.sf == null || c.fin == null) return null;
  if (finalDudoso(c)) return null;
  const { meta, margen } = metaYMargen(hmDe(c.fin));
  const real = c.sf >= 94 ? c.sf + 3 : c.sf;
  if (real >= meta - margen) return null;
  const propias = new Set(c.tr ?? []);
  const volvio = todas.some((x) => {
    const i = Number(x.inicio instanceof Date ? x.inicio.getTime() : x.inicio);
    return !propias.has(x.tr) && i > c.fin && i - c.fin <= VUELVE_MIN * MIN && x.socIni != null &&
      Math.abs(x.socIni - c.sf) <= VUELVE_PCT;
  });
  return volvio ? null : { sf: c.sf, fin: c.fin, meta };
}

/// Propuesta para un bus según su carga en el cruce (o null). `clave` sirve para no repetir una descartada.
/// [todas] = cargas crudas de Dhemax del turno (para saber si el bus volvió a cargar).
export function propuestaDe(b, r, todas = []) {
  if (!b.coordenada || b.incidencia) return null;
  if (!r || !['confirmada', 'probable'].includes(r.estado) || !r.carga) return null;
  const c = r.carga;
  if (c.continuaEn && c.continuaEn !== b.coordenada) {
    const pct = c.cambio?.pct ?? null;
    return {
      tipo: 'CAMBIO', pistolaNueva: c.continuaEn, pctCambio: pct,
      texto: `siguió en ${c.continuaEn}${pct == null ? '' : ` desde ${pct}%`}${c.cambio?.hora ? ` (${hm(c.cambio.hora)})` : ''}`,
      clave: `CAMBIO|${c.continuaEn}`,
    };
  }
  if (c.corte) {
    return {
      tipo: 'CORTE', pct: c.corte.pct ?? null,
      texto: `se cortó${c.corte.pct == null ? '' : ` en ${c.corte.pct}%`}${c.corte.hora ? ` (${hm(c.corte.hora)})` : ''} y se reconectó`,
      clave: `CORTE|${c.corte.hora ?? ''}`,
    };
  }
  const k = cargaCortada(c, todas);
  if (k) {
    return {
      tipo: 'CORTE', pct: k.sf,
      texto: `la carga terminó en ${k.sf}% (${hm(k.fin)}), bajo la meta de ${k.meta}%: ¿se cortó?`,
      clave: `CORTE|${k.fin}`,
    };
  }
  return null;
}

export async function proponerIncidencias(db) {
  if (!hayDhemax()) return;
  const ahora = new Date();
  const turno = await turnoACorregir(db, ahora); // 'AAAAMMDD_AM' / '_PM', o null (turnos manuales sin iniciar)
  if (!turno) return;
  const [dia, t] = turno.split('_');
  const [desde] = ventana(t, dia);
  const cargas = await cargasDhemaxEntre(desde, ahora);
  if (!cargas.length) return;
  await marcarEnCurso(cargas, ahora.getTime());
  const docs = (await db.collection('semaforoch').get()).docs;
  const buses = docs.map((d) => ({ id: d.id, ...d.data() }));
  const dh = emparejar(buses, cargas, []);
  const { FieldValue } = await import('firebase-admin/firestore');
  const batch = db.batch();
  const nuevas = [];
  for (const d of docs) {
    const b = { id: d.id, ...d.data() };
    const p = propuestaDe(b, dh.porBus.get(d.id), cargas);
    if (!p || b.propuestaDescartada === p.clave || b.propuesta?.clave === p.clave) continue;
    batch.update(d.ref, { propuesta: { ...p, en: FieldValue.serverTimestamp() } });
    nuevas.push(`${b.ppu ?? d.id}: ${p.texto}`);
  }
  if (!nuevas.length) {
    console.log(`Propuestas de incidencia (${chile(ahora).dia}): nada nuevo.`);
    return;
  }
  await batch.commit();
  console.log(`Propuestas de incidencia: ${nuevas.length}`);
  for (const n of nuevas) console.log('  ', n);
}
