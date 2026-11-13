// Corrección automática del semáforo con los datos del SGDC.
// La activa el admin en la app (config/autoSgdc). Con el modo "fueraDeTurno" solo corrige
// cuando ningún admin está en su turno (según sus ventanas de edición).
// Corrige lo mismo que el botón "Corregir con SGDC": % inicial y final, pistola y jornada.

const TOLERANCIA = 2; // puntos de %
const PISTOLAS = new Set([
  'B7-L', 'B7-R', 'B8-L', 'B8-R', 'B9-L', 'B9-R', 'B10-L', 'B10-R', 'B11-L', 'B11-R',
  'B12-L', 'B12-R', 'B13-L', 'B13-R', 'A1-L', 'A1-R', 'A2-L', 'A2-R', 'A3-L', 'A3-R',
  'A4-L', 'A4-R', 'A5-L', 'A5-R', 'A6-L', 'A6-R',
]);

export const ETIQUETAS = { pctInicial: '% INICIAL', pctFinal: '% FINAL', coordenada: 'COORDENADA', jornada: 'JORNADA/ EVENTO' };

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
function jornadaDe(d) {
  const { hm } = chile(d);
  if (hm >= 830 && hm < 1200) return 'M';
  if (hm >= 1200 && hm <= 1800) return 'T';
  return 'N';
}

const distinto = (a, b) => a != null && b != null && Math.abs(a - b) > TOLERANCIA;
export const fmt = (v) => (v == null ? '—' : String(v));

/// ¿Algún admin está ahora dentro de su ventana de turno?
async function adminEnTurno(db, ahora) {
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

/// Desde cuándo NO se deben volver a escribir cargas de [turno] ('AAAAMMDD_AM' / '_PM'): la hora del
/// último "Cerrar turno" de ESE MISMO turno, o del último "Limpiar semáforo", lo que sea más nuevo.
/// El cierre de OTRO turno no corta nada (si el diurno se cierra a las 20:40, las cargas del
/// nocturno de 20:00–20:40 siguen valiendo). Devuelve null si no hay corte.
export async function ultimoCierre(db, turno) {
  const s = await db.collection('turnos').orderBy('cerradoEn', 'desc').limit(1).get();
  const t = s.docs[0]?.data();
  const clave = t ? `${String(t.dia ?? '').replace(/-/g, '')}_${t.turno}` : null;
  const cierre = t && (!turno || clave === turno) ? t.cerradoEn?.toDate?.() ?? null : null;
  const limpieza = (await db.doc('config/limpieza').get()).data()?.fecha?.toDate?.() ?? null;
  if (!cierre) return limpieza;
  if (!limpieza) return cierre;
  return cierre > limpieza ? cierre : limpieza;
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
async function turnoACorregir(db, ahora) {
  const m = await turnoManual(db);
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
    if (v != null && b[k] !== v) cambios[k] = { antes: b[k] ?? null, despues: v };
  };
  if (b.pctInicial == null || distinto(b.pctInicial, socInicio)) poner('pctInicial', socInicio);
  if (b.pctFinal == null || distinto(b.pctFinal, socFin)) poner('pctFinal', socFin);
  if (!b.coordenada && PISTOLAS.has(ultima.pistola)) poner('coordenada', ultima.pistola);
  if (!b.jornada || (['M', 'T', 'N'].includes(b.jornada) && b.jornada !== jornada)) poner('jornada', jornada);
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
  const turno = await turnoACorregir(db, ahora);
  if (!turno) {
    console.log('Corrección automática: no hay turno iniciado, no se corrige.');
    return;
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
