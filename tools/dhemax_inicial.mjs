// % inicial con Dhemax apenas parte la carga (lo llama dhemax_sync.mjs cuando el informe trae cargas nuevas).
//
// Por qué: el bombero anota con el botón ⚡ cuando el bus queda en la pistola, casi siempre 1–12 min ANTES de que
// parta la carga (25-11: 33 de 41). Ahí Dhemax aún no tiene el inicial y el botón usa digiCAR, que marca 1–2 puntos
// menos y a veces 4–9; el SGDC lo corregía recién 40 min a 2 h 40 después.
//
// Qué hace: por cada carga nueva en curso (partió hace < 30 min), busca el bus anotado en esa pistola. Si la
// pistola se le anotó entre 60 min antes y 15 min después de que partió la carga, y desde entonces no hubo otra
// carga en esa pistola (sería una reconexión), le pone el % inicial de Dhemax si lo tiene vacío o difiere en más
// de 2 puntos. No pisa lo que una persona corrigió a mano después de anotar, ni lo que ya corrigió un robot.
// Usa el mismo interruptor y reglas que la corrección automática con SGDC (config/autoSgdc, turnos manuales,
// cierre de turno). Historial "Robot Dhemax".
// Lecturas: solo cuando hay cargas nuevas (~50 por turno): las reglas (~4) + 1 por pistola + el historial del bus.

import {
  ETIQUETAS, adminEnTurno, fmt, turnoACorregir, turnoAnteriorEnEspera, turnoDe, turnoManual, ultimoCierre, yaCerrado,
} from './auto_correccion.mjs';

const TOLERANCIA = 2; // puntos de %
const RECIENTE_MIN = 30; // carga que partió hace más que esto: ya no se mira (la corrige el SGDC)
const EN_CURSO_MIN = 10; // última lectura del cargador más vieja que esto = terminó
const ANTES_MIN = 60; // pistola anotada hasta esto antes de que parta la carga
const DESPUES_MIN = 15; // … o hasta esto después
// Dhemax a veces registra la carga tarde (25-11 en la mañana: 15–35 min) y entonces su % inicial es el de ese
// momento, ya avanzada (4–9 puntos de más; se nota en los kWh por punto). Hasta 12 min de atraso calzó siempre
// con el SGDC (±1).
export const ATRASO_MAX_MIN = 12;
const MIN = 60000;

const aMs = (t) => (t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : typeof t === 'number' ? t : null);

/// ¿El % inicial de esta carga es confiable? Solo si Dhemax la registró a tiempo (`ap` = cuándo la vio el robot).
export const siConfiable = (c) => c.si > 0 && c.ini != null && c.ap != null && c.ap - c.ini <= ATRASO_MAX_MIN * MIN;

/// Cargas que vale la pena mirar: en curso, recién partidas, con % inicial confiable y pistola.
export function cargasRecientes(nuevas, ahora = Date.now()) {
  return nuevas.filter((c) => c.p && /^[AB]\d+-[LR]$/.test(c.p) && siConfiable(c) &&
    ahora - c.ini < RECIENTE_MIN * MIN && c.fin != null && ahora - c.fin < EN_CURSO_MIN * MIN);
}

/// Qué cambiarle al bus [b] con la carga [carga] de Dhemax. [historial] = sus últimos cambios, del más nuevo al
/// más viejo ({ fecha (ms), usuario, cambios }). [cargas] = todas las de dhemax/hoy (para ver reconexiones).
/// [cierre] = último cierre o limpieza (ms) o null. Devuelve { pctInicial: { antes, despues } } o null, con el motivo.
export function decidir(b, carga, historial, cargas, cierre) {
  if (b.coordenada !== carga.p) return { no: 'otra pistola' };
  const anot = historial.find((h) => h.cambios?.coordenada && h.cambios.coordenada.despues === carga.p);
  if (!anot) return { no: 'no se ve cuándo se anotó la pistola' };
  if (anot.fecha < carga.ini - ANTES_MIN * MIN || anot.fecha > carga.ini + DESPUES_MIN * MIN) {
    return { no: 'la pistola se anotó lejos de la hora de la carga' };
  }
  if (cierre != null && anot.fecha <= cierre) return { no: 'anotado antes del último cierre' };
  // Otra carga en la misma pistola entre la anotación y esta: esta es una reconexión, el inicial es el de antes.
  if (Object.values(cargas).some((o) => o !== carga && o.p === carga.p && o.ini > anot.fecha && o.ini < carga.ini)) {
    return { no: 'hubo otra carga antes en esa pistola (reconexión)' };
  }
  // Alguien cambió el % inicial después de anotar (una persona a mano o un robot): no se pisa.
  const pct = historial.find((h) => h.cambios?.pctInicial);
  if (pct && pct.fecha > anot.fecha + MIN && pct !== anot) return { no: `% inicial ya cambiado por ${pct.nombre ?? pct.usuario}` };
  const antes = b.pctInicial ?? null;
  if (antes != null && Math.abs(antes - carga.si) <= TOLERANCIA) return { no: `ya calza (${antes} vs ${carga.si})` };
  return { cambios: { pctInicial: { antes, despues: carga.si } } };
}

/// Revisa las cargas nuevas del informe y corrige el % inicial del bus anotado en cada pistola.
export async function corregirInicialDhemax(db, nuevas, cargas, ahora = new Date()) {
  const lista = cargasRecientes(nuevas, ahora.getTime());
  if (!lista.length) return;

  const cfg = (await db.doc('config/autoSgdc').get()).data() ?? {};
  if (!cfg.activo) return console.log('   % inicial Dhemax: corrección automática apagada.');
  const manual = await turnoManual(db);
  const turno = await turnoACorregir(db, ahora, manual);
  if (!turno) return console.log('   % inicial Dhemax: no hay turno iniciado.');
  // Entre el cambio de turno y el cierre automático el semáforo aún tiene el turno anterior sin cerrar: se espera.
  if (!manual.manual) {
    const previo = turnoAnteriorEnEspera(turno, ahora);
    if (previo && !(await yaCerrado(db, previo.split('_')[1], previo.split('_')[0]))) {
      return console.log(`   % inicial Dhemax: el turno anterior (${previo}) aún no se cierra; se espera al cierre.`);
    }
  }
  if ((cfg.modo ?? 'fueraDeTurno') === 'fueraDeTurno') {
    const quien = await adminEnTurno(db, ahora);
    if (quien) return console.log(`   % inicial Dhemax: no se corrige, ${quien} está en turno.`);
  }
  const cierre = aMs(await ultimoCierre(db, turno));

  const { FieldValue } = await import('firebase-admin/firestore');
  for (const carga of lista) {
    if (turnoDe(new Date(carga.ini)) !== turno) continue;
    const s = await db.collection('semaforoch').where('coordenada', '==', carga.p).get();
    if (s.empty) {
      console.log(`   % inicial Dhemax ${carga.p} (${carga.si} %): ningún bus anotado en esa pistola.`);
      continue;
    }
    // La pistola queda anotada todo el turno: puede haber varios buses. Vale el único anotado cerca de esta carga.
    const evaluados = [];
    for (const d of s.docs) {
      const b = d.data();
      const ppu = String(b.ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const h = await d.ref.collection('historial').orderBy('fecha', 'desc').limit(10).get();
      const historial = h.docs.map((x) => ({ ...x.data(), fecha: aMs(x.data().fecha) ?? 0 }));
      evaluados.push({ d, ppu, r: decidir(b, carga, historial, cargas, cierre) });
    }
    const corregir = evaluados.filter((x) => x.r.cambios);
    const calzan = evaluados.filter((x) => /ya calza/.test(x.r.no ?? ''));
    if (corregir.length !== 1 || calzan.length) {
      const porque = corregir.length > 1 ? `${corregir.length} buses podrían ser (${corregir.map((x) => x.ppu).join(', ')})`
        : evaluados.map((x) => `${x.ppu}: ${x.r.no ?? 'otro bus calza'}`).join(' · ');
      console.log(`   % inicial Dhemax ${carga.p} (${carga.si} %): no se corrige (${porque}).`);
      continue;
    }
    const { d, ppu, r } = corregir[0];
    const detalle = Object.entries(r.cambios)
      .map(([k, v]) => `${ETIQUETAS[k] ?? k}: ${fmt(v.antes)} → ${fmt(v.despues)}`).join(' · ');
    const batch = db.batch();
    batch.update(d.ref, {
      pctInicial: carga.si,
      actualizado: FieldValue.serverTimestamp(),
      actualizadoPor: 'robot',
      actualizadoPorNombre: 'Robot Dhemax',
    });
    batch.set(d.ref.collection('historial').doc(), {
      fecha: FieldValue.serverTimestamp(), usuario: 'robot', nombre: 'Robot Dhemax', cambios: r.cambios,
    });
    batch.set(db.collection('actividad').doc(), {
      fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Robot Dhemax', tipo: 'Corrigió con Dhemax', detalle, ppu,
    });
    await batch.commit();
    console.log(`   % inicial Dhemax ${carga.p} ${ppu}: ${detalle}`);
  }
}
