// Corrección automática del semáforo con los datos del SGDC.
// La activa el admin en la app (config/autoSgdc). Con el modo "fueraDeTurno" solo corrige
// cuando ningún admin está en su turno (según sus ventanas de edición).
// Corrige lo mismo que el botón "Corregir con SGDC": % inicial y final, pistola y jornada.

import { PISTOLAS } from './dhemax_cruce.mjs'; // una sola lista de las 26 pistolas

const TOLERANCIA = 2; // puntos de %

export const ETIQUETAS = {
  pctInicial: '% INICIAL', pctFinal: '% FINAL', coordenada: 'COORDENADA', jornada: 'JORNADA', condicion: 'CONDICIÓN',
};

/// Condición del bus (PT taller, AV vidrio, FS, OT otro terminal), aparte de la carga. Lee también los datos de
/// antes del campo `condicion`, cuando iba en `jornada` (PT, AV, FS, PIEA, TSC). Igual que Bus.condicionEf en la app.
export function condicionDe(b) {
  if (b.condicion) return b.condicion;
  if (['PT', 'AV', 'FS'].includes(b.jornada)) return b.jornada;
  if (['PIEA', 'TSC'].includes(b.jornada)) return 'OT';
  return null;
}
const CONDICION_VIEJA = new Set(['PT', 'AV', 'FS', 'PIEA', 'TSC']);

const normaPpu = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/// Error de reserva anotado (incidencia RESERVA): el bus cargó con la reserva de otra patente (`ppuReserva`), así
/// que en el SGDC su carga quedó a nombre de esa patente. Pasa a este bus las cargas de esa patente en su(s)
/// pistola(s) (la anotada y la del cambio, si hubo); la otra patente ya no las tiene. Sin pistola en el bus (no cargó, p. ej.
/// el bombero se equivocó con un bus en taller): pasa las de esa patente salvo las que están en las pistolas
/// anotadas del otro bus (su carga propia). Si NINGUNO de los dos buses tiene pistola anotada (no hay cómo saber cuál
/// es de quién), solo se mueve si la otra patente tiene UNA sola carga en el turno; con más no se mueve y el
/// resultado trae el aviso para el log (26-11). Cambia [porPpu] (Map
/// patente normalizada → cargas). Sirve también para el cruce de dos buses (cada uno anota la del otro).
export function reasignarReservas(buses, porPpu) {
  const movidas = [];
  const yaMovidas = new Set(); // en un cruce sin pistola, lo que ya se movió no vuelve
  for (const b of buses) {
    if (b.incidencia !== 'RESERVA' || !b.ppuReserva) continue;
    const de = normaPpu(b.ppuReserva);
    const a = normaPpu(b.ppu ?? b.id);
    if (!de || de === a) continue;
    const pistolas = new Set([b.coordenada, b.pistolaNueva].filter(Boolean));
    const l = porPpu.get(de) ?? [];
    let mover;
    if (pistolas.size) {
      mover = l.filter((c) => pistolas.has(c.pistola));
    } else {
      // Sin pistola anotada (p. ej. un bus en taller o con vidrio que no cargó): se mueven las cargas de la otra
      // patente que no sean las propias de ese otro bus (las de la(s) pistola(s) que él tiene anotadas).
      const otro = buses.find((x) => normaPpu(x.ppu ?? x.id) === de);
      const propias = new Set([otro?.coordenada, otro?.pistolaNueva].filter(Boolean));
      mover = l.filter((c) => !propias.has(c.pistola) && !yaMovidas.has(c));
      if (!propias.size && mover.length > 1) {
        movidas.push(`${a}: no se movió nada de ${de} (${mover.length} cargas en el turno y ningún bus tiene pistola anotada)`);
        continue;
      }
    }
    if (!mover.length) continue;
    for (const c of mover) yaMovidas.add(c);
    porPpu.set(de, l.filter((c) => !mover.includes(c)));
    porPpu.set(a, [...(porPpu.get(a) ?? []), ...mover]
      .sort((x, y) => (x.inicio ?? x.reserva ?? 0) - (y.inicio ?? y.reserva ?? 0)));
    movidas.push(`${a} ← ${mover.length} de ${de}`);
  }
  return movidas;
}

/// Jornada M/T/N que hay que poner por la hora de la carga (null si ya está bien). Si en `jornada` había una
/// condición vieja (PT…) o NI, se reemplaza y la condición pasa a su campo (ver [condicionDe]).
export function cambiosJornada(b, jornada, poner) {
  if (!jornada || b.jornada === 'R' || b.jornada === jornada) return;
  if (['M', 'T', 'N'].includes(b.jornada) || !b.jornada || b.jornada === 'NI' || CONDICION_VIEJA.has(b.jornada)) {
    if (CONDICION_VIEJA.has(b.jornada) && !b.condicion) {
      poner('condicion', condicionDe(b));
      if (b.jornada === 'PIEA') poner('lugar', 'Pie Andino');
      if (b.jornada === 'TSC') poner('lugar', 'San Carlos');
    }
    poner('jornada', jornada);
  }
}

/// Hora de Chile de una fecha: { dia: 'AAAAMMDD', hm: 1345 }
export function chile(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Santiago', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { dia: `${p.year}${p.month}${p.day}`, hm: Number(p.hour) * 100 + Number(p.minute) };
}

/// Turno al que pertenece un momento: diurno 07:30–20:00; nocturno 20:00–07:30 (del día en que empezó).
export function turnoDe(d) {
  const { dia, hm } = chile(d);
  if (hm >= 730 && hm < 2000) return `${dia}_AM`;
  if (hm >= 2000) return `${dia}_PM`;
  const ayer = chile(new Date(d.getTime() - 12 * 3600 * 1000)).dia;
  return `${ayer}_PM`;
}

/// Jornada según la hora de inicio de la carga: 08:30–11:59 M, 12:00–18:00 T, resto N.
export function jornadaDe(d) {
  const { hm } = chile(d);
  if (hm >= 830 && hm < 1200) return 'M';
  if (hm >= 1200 && hm <= 1800) return 'T';
  return 'N';
}

const distinto = (a, b) => a != null && b != null && Math.abs(a - b) > TOLERANCIA;
export const fmt = (v) => (v == null ? '—' : String(v));

/// ¿Algún admin está ahora dentro de su ventana de turno?
export async function adminEnTurno(db, ahora) {
  const s = await db.collection('usuarios').where('rol', '==', 'admin').get();
  for (const u of s.docs) {
    const v = u.data().ventanas ?? {};
    for (const w of Object.values(v)) {
      const i = w?.i?.toDate?.();
      const f = w?.f?.toDate?.();
      if (i && f && ahora >= i && ahora < f) return u.data().nombre ?? u.id;
    }
  }
  return null;
}

/// Desde cuándo NO se deben volver a escribir cargas: la hora del último "Cerrar turno" vigente de CUALQUIER turno,
/// o del último "Limpiar semáforo", lo que sea más nuevo. Una carga pertenece al turno que la cerró (decisión 26-11):
/// si el nocturno se cierra a las 07:45, la carga que partió 07:35 ya quedó en esa foto y el diurno no la reescribe;
/// una que parte 07:50 sí vale. Devuelve null si no hay corte. Los turnos anulados por el admin (anulado: true) no
/// cuentan. [turno] ya no se usa (se deja por compatibilidad con quienes llaman).
export async function ultimoCierre(db, _turno) {
  const s = await db.collection('turnos').orderBy('cerradoEn', 'desc').limit(10).get();
  const limpieza = (await db.doc('config/limpieza').get()).data()?.fecha?.toDate?.() ?? null;
  return corteDeCierres(s.docs.map((d) => d.data()), limpieza);
}

/// Parte pura de [ultimoCierre]: el más nuevo entre el último cierre no anulado (de cualquier turno) y la limpieza.
export function corteDeCierres(turnos, limpieza = null) {
  const t = (turnos ?? []).find((x) => x.anulado !== true);
  const cierre = t?.cerradoEn?.toDate?.() ?? t?.cerradoEn ?? null;
  if (!cierre) return limpieza;
  if (!limpieza) return cierre;
  return cierre > limpieza ? cierre : limpieza;
}

/// ¿Hay un cierre vigente (no anulado por el admin) de ese turno? (dia = 'AAAAMMDD' en que empezó)
export async function yaCerrado(db, turno, dia) {
  const s = await db.collection('turnos')
    .where('dia', '==', `${dia.slice(0, 4)}-${dia.slice(4, 6)}-${dia.slice(6, 8)}`).where('turno', '==', turno).get();
  return s.docs.some((d) => d.data().anulado !== true);
}

/// Los turnos no se sobreponen: el anterior se cierra antes de que empiece el otro. Entre el cambio de turno y la
/// hora del cierre automático (07:40 / 20:40) el semáforo todavía tiene los datos del turno que terminó. Devuelve
/// la clave 'AAAAMMDD_AM'/'_PM' de ese turno anterior si [turno] (el de ahora) está en esa espera; si no, null.
export function turnoAnteriorEnEspera(turno, ahora) {
  const { dia, hm } = chile(ahora);
  const [d, t] = String(turno).split('_');
  const enEspera = d === dia && ((t === 'AM' && hm < 740) || (t === 'PM' && hm >= 2000 && hm < 2040));
  return enEspera ? turnoDe(new Date(ahora.getTime() - 3600 * 1000)) : null;
}

/// Turno iniciado a mano (config/app.turnoActual) si el admin activó los turnos manuales.
/// Devuelve { manual: false } si están apagados, { manual: true, turno, dia } si hay uno abierto
/// (dia = AAAAMMDD en que empezó) o { manual: true } si no hay ninguno iniciado.
export async function turnoManual(db) {
  const app = (await db.doc('config/app').get()).data() ?? {};
  if (app.turnosManuales !== true) return { manual: false };
  const t = app.turnoActual;
  if (!t?.abierto) return { manual: true };
  return { manual: true, turno: t.turno === 'PM' ? 'PM' : 'AM', dia: String(t.dia ?? '').replace(/-/g, '') };
}

/// Clave 'AAAAMMDD_AM' del turno que se corrige ahora: el iniciado, o el que toca por la hora.
/// Null si los turnos son manuales y no hay ninguno iniciado.
export async function turnoACorregir(db, ahora, manual = null) {
  const m = manual ?? await turnoManual(db);
  if (!m.manual) return turnoDe(ahora);
  return m.turno ? `${m.dia}_${m.turno}` : null;
}

/// Qué hay que cambiarle a un bus del semáforo para que calce con sus cargas del SGDC
/// (las de un turno). Devuelve { campo: { antes, despues } }; vacío si ya calza o no cargó.
export function cambiosSgdc(b, cargasBus) {
  const l = [...cargasBus].sort((x, y) => (x.inicio ?? 0) - (y.inicio ?? 0));
  const cambios = {};
  if (!l.length) return cambios;
  const primera = l[0];
  const ultima = l[l.length - 1];
  const enProceso = ultima.estado && ultima.estado !== 'Finalizada';
  const socInicio = primera.socInicio ?? null;
  const socFin = enProceso ? null : (ultima.socFin ?? null);
  const jornada = ultima.inicio ? jornadaDe(ultima.inicio) : null;
  const poner = (k, v) => {
    if ((v != null || k === 'motivo') && (b[k] ?? null) !== v) cambios[k] = { antes: b[k] ?? null, despues: v };
  };
  // Anotada con el patio caído (sinPatio): el SGDC tiene a lo más una parte de la carga, así que
  // solo se rellenan los % vacíos y no se pisa lo que anotaron los bomberos.
  const pisar = b.sinPatio !== true;
  if (b.pctInicial == null || (pisar && distinto(b.pctInicial, socInicio))) poner('pctInicial', socInicio);
  if (b.pctFinal == null || (pisar && distinto(b.pctFinal, socFin))) poner('pctFinal', socFin);
  // Sin pistola anotada: la de la primera carga; si siguió en otra pistola, queda como cambio de pistola.
  if (!b.coordenada && PISTOLAS.has(primera.pistola)) {
    poner('coordenada', primera.pistola);
    if (!b.incidencia && PISTOLAS.has(ultima.pistola) && ultima.pistola !== primera.pistola) {
      poner('incidencia', 'CAMBIO');
      poner('pistolaNueva', ultima.pistola);
    }
  }
  cambiosJornada(b, jornada, poner);
  // Cargó: ya no corre el motivo de no carga.
  if (b.motivo && (b.coordenada || cambios.coordenada)) poner('motivo', null);
  return cambios;
}

/// Corrige el semáforo con las cargas del SGDC del turno en curso.
export async function autoCorregir(db, cargas) {
  const cfg = (await db.doc('config/autoSgdc').get()).data() ?? {};
  if (!cfg.activo) {
    console.log('Corrección automática: apagada.');
    return;
  }
  const ahora = new Date();
  // Turnos manuales: solo se corrige el turno iniciado; sin turno iniciado no se toca el semáforo.
  const manual = await turnoManual(db);
  const turno = await turnoACorregir(db, ahora, manual);
  if (!turno) {
    console.log('Corrección automática: no hay turno iniciado, no se corrige.');
    return;
  }
  // Turnos por hora (no manuales): entre el cambio de turno y el cierre automático el semáforo aún tiene los datos
  // del turno anterior sin cerrar; corregir ahora mezclaría un turno con el otro. Se espera al cierre.
  if (!manual.manual) {
    const previo = turnoAnteriorEnEspera(turno, ahora);
    if (previo && !(await yaCerrado(db, previo.split('_')[1], previo.split('_')[0]))) {
      console.log(`Corrección automática: el turno anterior (${previo}) aún no se cierra; se espera al cierre, no se corrige.`);
      return;
    }
  }
  if ((cfg.modo ?? 'fueraDeTurno') === 'fueraDeTurno') {
    const quien = await adminEnTurno(db, ahora);
    if (quien) {
      console.log(`Corrección automática: no se corrige, ${quien} está en turno.`);
      return;
    }
  }

  // Lo que ya se cerró no se vuelve a cargar: solo cuentan las cargas que empezaron
  // después del último "Cerrar turno". Así, si el nocturno cierra y limpia el semáforo,
  // el robot no lo vuelve a llenar con esas mismas cargas.
  const cierre = await ultimoCierre(db, turno);
  if (cierre) console.log(`Corrección automática: último cierre o limpieza ${cierre.toISOString()}.`);
  const porPpu = new Map();
  let antiguas = 0;
  for (const c of cargas) {
    const f = c.inicio ?? c.reserva;
    if (!f || turnoDe(f) !== turno) continue;
    if (cierre && f <= cierre) {
      antiguas++;
      continue;
    }
    if (!porPpu.has(c.ppu)) porPpu.set(c.ppu, []);
    porPpu.get(c.ppu).push(c);
  }

  if (antiguas) console.log(`Corrección automática: ${antiguas} cargas son de antes del cierre de turno, no se tocan.`);

  const { FieldValue } = await import('firebase-admin/firestore');
  const buses = await db.collection('semaforoch').get();
  // Errores de reserva anotados: la carga a nombre de otra patente es de este bus.
  for (const m of reasignarReservas(buses.docs.map((d) => ({ id: d.id, ...d.data() })), porPpu)) {
    console.log(`Corrección automática: error de reserva ${m}.`);
  }
  const batch = db.batch();
  const resumen = [];
  for (const d of buses.docs) {
    const b = d.data();
    const ppu = String(b.ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cambios = cambiosSgdc(b, porPpu.get(ppu) ?? []);
    if (!Object.keys(cambios).length) continue;

    const nuevos = Object.fromEntries(Object.entries(cambios).map(([k, v]) => [k, v.despues]));
    batch.update(d.ref, {
      ...nuevos,
      actualizado: FieldValue.serverTimestamp(),
      actualizadoPor: 'robot',
      actualizadoPorNombre: 'Robot SGDC',
    });
    batch.set(d.ref.collection('historial').doc(), {
      fecha: FieldValue.serverTimestamp(),
      usuario: 'robot',
      nombre: 'Robot SGDC',
      cambios,
    });
    const detalle = Object.entries(cambios)
      .map(([k, v]) => `${ETIQUETAS[k] ?? k}: ${fmt(v.antes)} → ${fmt(v.despues)}`)
      .join(' · ');
    batch.set(db.collection('actividad').doc(), {
      fecha: FieldValue.serverTimestamp(),
      uid: 'robot',
      nombre: 'Robot SGDC',
      tipo: 'Corrigió con SGDC',
      detalle,
      ppu,
    });
    resumen.push(`${ppu}: ${detalle}`);
  }
  if (!resumen.length) {
    console.log('Corrección automática: nada que corregir.');
    return;
  }
  batch.set(db.doc('config/autoSgdc'), {
    ultima: FieldValue.serverTimestamp(),
    ultimaCantidad: resumen.length,
  }, { merge: true });
  await batch.commit();
  console.log(`Corrección automática: ${resumen.length} buses corregidos.`);
  for (const r of resumen) console.log('  ', r);
}

// ------------------------------------------------------------ Taller
export const TALLER_VIEJO_MIN = 150; // reporte de taller más viejo que esto: no se corrige con él (igual que la app)

/// Qué cambiarle a un bus según el reporte de taller (lo mismo que el botón de la pestaña Taller). La condición va
/// aparte de la carga: en taller y sin otra condición → PT (aunque haya cargado); con PT y ya no está en taller → sin
/// condición (y sin la sigla vieja PT en la jornada).
/// ¿El PT lo puso a mano una persona? (`condicionPor.uid` distinto de 'robot'). Sin `condicionPor` (datos viejos) = no.
export function ptDePersona(b) {
  const uid = b.condicionPor?.uid;
  return condicionDe(b) === 'PT' && !!uid && uid !== 'robot';
}

/// Qué guardar en `condicionPor` según los cambios de taller: el robot al poner PT, null al quitarlo, undefined
/// (no tocar) si la condición no cambió. `fecha` es el serverTimestamp.
export function condicionPorTaller(cambios, fecha) {
  if (!cambios.condicion) return undefined;
  return cambios.condicion.despues === 'PT' ? { uid: 'robot', nombre: 'Robot Taller', fecha } : null;
}

export function cambiosTaller(b, enTaller) {
  const c = condicionDe(b);
  if (enTaller && !c) return { condicion: { antes: b.condicion ?? null, despues: 'PT' } };
  if (!enTaller && c === 'PT') {
    if (ptDePersona(b)) return {}; // lo puso una persona: lo quita una persona
    return {
      condicion: { antes: b.condicion ?? 'PT', despues: null },
      ...(b.jornada === 'PT' ? { jornada: { antes: 'PT', despues: null } } : {}),
    };
  }
  return {};
}

/// ¿Sirve el reporte de taller (`taller/flota`) para corregir? Atrasado (> 150 min) o sin buses en taller (suele ser
/// una falla del Power BI) = no se toca el PT de nadie. Devuelve { ok, motivo ('atrasado' | 'vacio' | null), enTaller }
/// con las patentes normalizadas. Lo usan la corrección automática y el cierre automático.
export function estadoTaller(t, ahora = new Date()) {
  const datos = t?.datos?.toDate?.() ?? null;
  const enTaller = new Set(Object.keys(t?.buses ?? {}).map(normaPpu));
  if (!datos || ahora - datos > TALLER_VIEJO_MIN * 60000) return { ok: false, motivo: 'atrasado', enTaller };
  if (!enTaller.size) return { ok: false, motivo: 'vacio', enTaller };
  return { ok: true, motivo: null, enTaller };
}

/// Corrige la jornada PT del semáforo con el reporte de taller (si el admin la dejó activada en config/autoTaller).
export async function autoCorregirTaller(db) {
  const cfg = (await db.doc('config/autoTaller').get()).data() ?? {};
  if (!cfg.activo) {
    console.log('Corrección automática del taller: apagada.');
    return;
  }
  const ahora = new Date();
  if (!(await turnoACorregir(db, ahora))) {
    console.log('Corrección automática del taller: no hay turno iniciado, no se corrige.');
    return;
  }
  if ((cfg.modo ?? 'fueraDeTurno') === 'fueraDeTurno') {
    const quien = await adminEnTurno(db, ahora);
    if (quien) {
      console.log(`Corrección automática del taller: no se corrige, ${quien} está en turno.`);
      return;
    }
  }
  const taller = estadoTaller((await db.doc('taller/flota').get()).data() ?? {}, ahora);
  if (taller.motivo === 'atrasado') {
    console.log('Corrección automática del taller: el reporte de taller está atrasado, no se corrige.');
    return;
  }
  if (taller.motivo === 'vacio') {
    // Un reporte vacío suele ser una falla del Power BI: no se le quita el PT a nadie por eso.
    console.log('Corrección automática del taller: el reporte no trae buses en taller, no se corrige.');
    return;
  }
  const enTaller = taller.enTaller;

  const { FieldValue } = await import('firebase-admin/firestore');
  const buses = await db.collection('semaforoch').get();
  const batch = db.batch();
  const resumen = [];
  for (const d of buses.docs) {
    const b = d.data();
    const ppu = String(b.ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cambios = cambiosTaller(b, enTaller.has(ppu));
    if (!Object.keys(cambios).length) continue;
    const por = condicionPorTaller(cambios, FieldValue.serverTimestamp());
    batch.update(d.ref, {
      ...Object.fromEntries(Object.entries(cambios).map(([k, v]) => [k, v.despues])),
      ...(por !== undefined ? { condicionPor: por } : {}),
      actualizado: FieldValue.serverTimestamp(),
      actualizadoPor: 'robot',
      actualizadoPorNombre: 'Robot Taller',
    });
    batch.set(d.ref.collection('historial').doc(), {
      fecha: FieldValue.serverTimestamp(), usuario: 'robot', nombre: 'Robot Taller', cambios,
    });
    const detalle = Object.entries(cambios).map(([k, v]) => `${ETIQUETAS[k] ?? k}: ${fmt(v.antes)} → ${fmt(v.despues)}`).join(' · ');
    batch.set(db.collection('actividad').doc(), {
      fecha: FieldValue.serverTimestamp(), uid: 'robot', nombre: 'Robot Taller', tipo: 'Corrigió con taller', detalle, ppu,
    });
    resumen.push(`${ppu}: ${detalle}`);
  }
  if (!resumen.length) {
    console.log('Corrección automática del taller: nada que corregir.');
    return;
  }
  batch.set(db.doc('config/autoTaller'), { ultima: FieldValue.serverTimestamp(), ultimaCantidad: resumen.length }, { merge: true });
  await batch.commit();
  console.log(`Corrección automática del taller: ${resumen.length} buses corregidos.`);
  for (const r of resumen) console.log('  ', r);
}
