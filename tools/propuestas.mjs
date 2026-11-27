// Etapa 2 del "Estado del bus": incidencias de carga que el robot ve en los cargadores (Dhemax) y PROPONE en la
// tarjeta del bus; el bombero las anota con un toque o las descarta (campo `propuesta` del bus en semaforoch).
//   - Cambio de pistola: su carga siguió en otra pistola (dhemax_cruce: continuaEn) → CAMBIO + pistolaNueva/pctCambio.
//   - Carga cortada: se cortó y se reconectó en la misma pistola (dhemax_cruce: corte) → CORTE.
//   - Carga cortada sin reconexión (26-11, caso 23-11 PM: 4 buses cortaron entre 23:15 y 23:32, SRPJ80 y SRRX41 en
//     76 %): la carga del turno terminó (Dhemax, ya no en curso) bajo meta − margen según la hora de fin y no
//     volvió a cargar → CORTE. Solo con Dhemax (no suma lecturas: el SGDC no se pide aquí).
//   - Corrección de pistola / % final (27-11): el SGDC y el cargador coinciden sin duda y lo anotado no calza →
//     PISTOLA {pistola, anotada} o PCT_FINAL {pct, anotado}; el bombero la aplica con "Corregir" (ver correccionDe).
// Solo turno en curso, solo buses con pistola, sin incidencia anotada y si la propuesta no se descartó antes
// (`propuestaDescartada` = clave). Corre con el vigilante del SGDC (una vez por hora): lee los 48 buses y Dhemax;
// escribe solo cuando hay una propuesta nueva.
import { calzaFinal, emparejar, cargasDhemaxEntre, finalDudoso, hayDhemax, marcarEnCurso } from './dhemax_cruce.mjs';
import { adminEnTurno, chile, turnoACorregir } from './auto_correccion.mjs';
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

const TOL_FINAL = 2; // el % final del SGDC y el del cargador tienen que estar a esto entre sí
const norma = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PRIORIDAD = { PISTOLA: 4, PCT_FINAL: 3, CAMBIO: 2, CORTE: 1 }; // mayor = más importante
const aMs = (x) => (x == null ? null : x instanceof Date ? x.getTime() : x?.toDate ? x.toDate().getTime() : Number(x));

/// La carga del SGDC (de las del bus) que corresponde a la del cargador: misma pistola y la que parte más cerca.
function sgdcDe(c, sgdcBus, pistola = c.pistola) {
  let mejor = null;
  for (const g of sgdcBus ?? []) {
    const i = aMs(g.inicio);
    if (g.pistola !== pistola || i == null) continue;
    const d = Math.abs(i - c.ini);
    if (!mejor || d < mejor.d) mejor = { g, d };
  }
  return mejor?.g ?? null;
}

/// Corrección PISTOLA o PCT_FINAL cuando el SGDC y el cargador coinciden sin duda y lo anotado no calza (o null).
/// [sgdcBus] = cargas del SGDC del turno a nombre del bus ({ pistola, inicio, fin, socInicio, socFin, estado }).
/// [autoCorrige] = true si la corrección automática ya pone sola el % final del SGDC (no se propone dos veces).
export function correccionDe(b, r, sgdcBus = [], { autoCorrige = false } = {}) {
  if (!b.coordenada || !r || b.incidencia === 'CAMBIO') return null;
  // PISTOLA: el bus no tiene carga en su pistola y el SGDC lo tiene (con el cargador de acuerdo) en otra.
  const o = r.estado === 'sin_carga' ? r.enOtraPistola : null;
  if (o && !o.enCurso && !o.continuaEn && o.pistola !== b.coordenada) {
    const g = sgdcDe(o, sgdcBus);
    const ini = aMs(g?.inicio), fin = aMs(g?.fin);
    if (g && ini != null && fin != null) {
      return {
        tipo: 'PISTOLA', pistola: o.pistola, anotada: b.coordenada,
        texto: `SGDC y cargador: cargó en ${o.pistola} (${hm(ini)}–${hm(fin)}, ${g.socInicio ?? '—'}→${g.socFin ?? '—'} %), no en ${b.coordenada}`,
        clave: `PISTOLA|${o.pistola}|${ini}`,
      };
    }
  }
  // PCT_FINAL: carga confirmada y terminada, SGDC y cargador dicen casi lo mismo y lo anotado no calza.
  const c = r.carga;
  if (autoCorrige || b.pctFinal == null || r.estado !== 'confirmada' || !r.estricta || !c) return null;
  if (c.enCurso || c.continuaEn || c.sf == null || finalDudoso(c)) return null;
  const g = sgdcDe(c, sgdcBus);
  const fin = aMs(g?.fin);
  if (!g || g.socFin == null || fin == null || (g.estado && g.estado !== 'Finalizada')) return null;
  if (Math.abs(g.socFin - c.sf) > TOL_FINAL || calzaFinal(b.pctFinal, g.socFin, TOL_FINAL)) return null;
  return {
    tipo: 'PCT_FINAL', pct: g.socFin, anotado: b.pctFinal,
    texto: `SGDC y cargador: terminó en ${g.socFin} % (${hm(fin)}); anotado ${b.pctFinal} %`,
    clave: `PCT_FINAL|${g.socFin}|${fin}`,
  };
}

/// Propuestas posibles para un bus, de mayor a menor prioridad: PISTOLA > PCT_FINAL > CAMBIO > CORTE.
/// `clave` sirve para no repetir una descartada. [todas] = cargas crudas de Dhemax del turno (para saber si el bus
/// volvió a cargar); [sgdcBus] = cargas del SGDC del bus.
export function propuestasDe(b, r, todas = [], sgdcBus = [], opciones = {}) {
  const l = [];
  const c = correccionDe(b, r, sgdcBus, opciones);
  if (c) l.push(c);
  const p = propuestaDe(b, r, todas);
  if (p) l.push(p);
  return l;
}

/// ¿La propuesta PISTOLA / PCT_FINAL puesta en el bus ya no aplica (alguien corrigió o cambió lo anotado)?
/// Las CAMBIO y CORTE no se tocan.
export function propuestaObsoleta(b) {
  const p = b.propuesta;
  if (p?.tipo === 'PISTOLA') return b.coordenada !== p.anotada;
  if (p?.tipo === 'PCT_FINAL') return b.pctFinal !== p.anotado || calzaFinal(b.pctFinal, p.pct, TOL_FINAL);
  return false;
}

/// ¿La corrección automática del SGDC va a poner sola el % final (config/autoSgdc activa y sin admin en turno si
/// está en "fuera de turno")? Entonces no se propone PCT_FINAL (auto_correccion.mjs: cambiosSgdc pisa el % final).
async function autoCorrigeSola(db, ahora) {
  const cfg = (await db.doc('config/autoSgdc').get()).data() ?? {};
  if (!cfg.activo) return false;
  if ((cfg.modo ?? 'fueraDeTurno') === 'fueraDeTurno') return !(await adminEnTurno(db, ahora));
  return true;
}

/// [cargasSgdc] = cargas del SGDC ya traídas por el vigilante (aCarga: { ppu, pistola, inicio, fin, socInicio, socFin,
/// estado }); sin ellas solo se proponen CAMBIO y CORTE, como antes.
export async function proponerIncidencias(db, cargasSgdc = []) {
  if (!hayDhemax()) return;
  const ahora = new Date();
  const turno = await turnoACorregir(db, ahora); // 'AAAAMMDD_AM' / '_PM', o null (turnos manuales sin iniciar)
  if (!turno) return;
  const [dia, t] = turno.split('_');
  const [desde, hasta] = ventana(t, dia);
  const cargas = await cargasDhemaxEntre(desde, ahora);
  if (!cargas.length) return;
  await marcarEnCurso(cargas, ahora.getTime());
  // SGDC del turno (solo el terminal Camilo, con pistola), por patente.
  const sgdc = (cargasSgdc ?? []).filter((c) => {
    const i = aMs(c.inicio);
    return c.pistola && i != null && i >= desde.getTime() && i < hasta.getTime() && /camilo/i.test(String(c.terminal ?? 'Camilo'));
  });
  const porPpu = new Map();
  for (const c of sgdc) {
    const k = norma(c.ppu);
    if (!porPpu.has(k)) porPpu.set(k, []);
    porPpu.get(k).push(c);
  }
  const autoCorrige = sgdc.length ? await autoCorrigeSola(db, ahora) : false;
  const docs = (await db.collection('semaforoch').get()).docs;
  const buses = docs.map((d) => ({ id: d.id, ...d.data() }));
  const dh = emparejar(buses, cargas, sgdc);
  const batch = db.batch();
  const nuevas = [];
  const limpiadas = [];
  const { FieldValue } = await import('firebase-admin/firestore');
  for (const d of docs) {
    const b = { id: d.id, ...d.data() };
    const lista = propuestasDe(b, dh.porBus.get(d.id), cargas, porPpu.get(norma(b.ppu ?? d.id)) ?? [], { autoCorrige });
    const p = lista.find((x) => b.propuestaDescartada !== x.clave);
    const obsoleta = propuestaObsoleta(b);
    if (p && b.propuesta?.clave !== p.clave) {
      // Una de mayor prioridad reemplaza a la puesta; una de menor no pisa una PISTOLA/PCT_FINAL que sigue vigente.
      if (b.propuesta && !obsoleta && PRIORIDAD[b.propuesta.tipo] < PRIORIDAD[p.tipo]) continue;
      batch.update(d.ref, { propuesta: { ...p, en: FieldValue.serverTimestamp() } });
      nuevas.push(`${b.ppu ?? d.id}: ${p.texto}`);
    } else if (!p && obsoleta) {
      batch.update(d.ref, { propuesta: null });
      limpiadas.push(`${b.ppu ?? d.id}: ${b.propuesta.tipo}`);
    }
  }
  if (!nuevas.length && !limpiadas.length) {
    console.log(`Propuestas de incidencia (${chile(ahora).dia}): nada nuevo.`);
    return;
  }
  await batch.commit();
  console.log(`Propuestas de incidencia: ${nuevas.length}${limpiadas.length ? `, ${limpiadas.length} ya corregidas (quitadas)` : ''}`);
  for (const n of nuevas) console.log('  ', n);
  for (const n of limpiadas) console.log('  quitada', n);
}
