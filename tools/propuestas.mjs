// Etapa 2 del "Estado del bus": incidencias de carga que el robot ve en los cargadores (Dhemax) y PROPONE en la
// tarjeta del bus; el bombero las anota con un toque o las descarta (campo `propuesta` del bus en semaforoch).
//   - Cambio de pistola: su carga siguió en otra pistola (dhemax_cruce: continuaEn) → CAMBIO + pistolaNueva/pctCambio.
//   - Carga cortada: se cortó y se reconectó en la misma pistola (dhemax_cruce: corte) → CORTE.
// Solo turno en curso, solo buses con pistola, sin incidencia anotada y si la propuesta no se descartó antes
// (`propuestaDescartada` = clave). Corre con el vigilante del SGDC (una vez por hora): lee los 48 buses y Dhemax;
// escribe solo cuando hay una propuesta nueva.
import { emparejar, cargasDhemaxEntre, hayDhemax, marcarEnCurso } from './dhemax_cruce.mjs';
import { chile, turnoACorregir } from './auto_correccion.mjs';
import { ventana } from './cierre_automatico.mjs';

const hm = (ms) => new Date(ms).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/// Propuesta para un bus según su carga en el cruce (o null). `clave` sirve para no repetir una descartada.
export function propuestaDe(b, r) {
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
    const p = propuestaDe(b, dh.porBus.get(d.id));
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
