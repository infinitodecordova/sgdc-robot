// Planillón de despacho ICR → Firestore (planillon/hoy): a qué hora sale cada bus del semáforo,
// por qué servicio y con qué conductor (solo primer nombre + primer apellido; NUNCA el RUT).
//
// Usuario y clave NUNCA van en un archivo: variables ICR_USUARIO e ICR_CLAVE (secretos en GitHub).
// El repo es público y sus logs también: el log muestra PPU y horas, nunca nombres de conductores.
//
// Modo loop (workflow planillon.yml): una pasada cada 3 min durante ~55 min o hasta que termine el
// horario (HORARIO, hora de Chile). Fuera de horario sale al tiro.
//   node planillon_sync.mjs --loop --cada 180
// Cada pasada lee de los 4 servicios el bloque actual y el siguiente (y el anterior en los primeros
// 15 min del bloque, para pillar horas reales anotadas tarde).
// Escribe planillon/hoy SOLO si cambió algo, máximo 1 vez cada 3 min, más un control cada 15 min.
// Al cambiar de día parte de cero (sin historial).
// Si el login o la consulta fallan: reintenta 1 vez; si sigue fallando deja ok:false + error y avisa
// en ERRORES (máximo 1 vez por hora; las fallas de red no se avisan). Con 3 logins rechazados seguidos
// se pausa 1 h (para no bloquear la cuenta del ICR) y la corrida termina.
//
// Probar en el PC (no escribe nada; si faltan, pide usuario y clave):
//   node planillon_sync.mjs --probar                                 una pasada
//   node planillon_sync.mjs --probar --loop --cada 60 --minutos 5 --siempre

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import {
  SERVICIOS, SesionIcr, bloqueDeAhora, diaChile, esErrorDeRed, fechaIcr, minutoChile,
} from './planillon_icr.mjs';

/// Horario del robot (hora de Chile, minutos desde medianoche). Cruza la medianoche: 05:00 → 00:30.
export const HORARIO = { desde: 5 * 60, hasta: 30 };

const ESCRITURA_MIN_MS = 3 * 60 * 1000 - 10000; // máx. 1 escritura cada ~3 min (10 s de holgura)
const CONTROL_MS = 15 * 60 * 1000; // aunque no cambie nada, para que la app lo vea vigente
const AVISO_ERROR_MS = 60 * 60 * 1000; // aviso en ERRORES: máximo 1 por hora
const ANTERIOR_MIN = 15; // en los primeros 15 min del bloque se relee el anterior
const PENDIENTE_MIN = 30; // una salida sin hora real se da por perdida 30 min después de su hora
const MAX_LOGIN_RECHAZADO = 3;
const PAUSA_LOGIN_MS = 60 * 60 * 1000;

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

export function enHorario(d = new Date()) {
  const m = minutoChile(d);
  return HORARIO.desde < HORARIO.hasta ? m >= HORARIO.desde && m < HORARIO.hasta : m >= HORARIO.desde || m < HORARIO.hasta;
}

/// Minutos que faltan para que termine el horario (0 si está fuera).
function minutosHastaFin(d = new Date()) {
  if (!enHorario(d)) return 0;
  const m = minutoChile(d);
  return m < HORARIO.hasta ? HORARIO.hasta - m : 24 * 60 - m + HORARIO.hasta;
}

const horaChile = (d = new Date()) => d.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false });
const ppuLimpia = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const aMin = (h) => (h ? Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5)) : null);
const clave = (s) => `${s.servicio}_${s.hora.replace(':', '')}`; // "1040-R_1004"

/// Ordena las llaves (para comparar con lo último escrito sin falsos cambios).
function ordenado(o) {
  if (Array.isArray(o)) return o.map(ordenado);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, ordenado(o[k])]));
  return o;
}

/**
 * Arma buses: { PPU: { servicio, hora, despacho, real, conductor, salio? } } a partir de las salidas del día.
 * - Manda la próxima salida sin hora real (que no esté perdida: hasta 30 min después de su hora).
 * - Si además ya salió antes, esa queda en `salio` ({ servicio, hora, real }).
 * - Si no le queda ninguna pendiente, va la última que salió (con `real`).
 */
export function armarBuses(salidas, minuto = minutoChile()) {
  const porPpu = {};
  for (const s of Object.values(salidas)) (porPpu[s.ppu] ??= []).push(s);
  const buses = {};
  for (const [ppu, l] of Object.entries(porPpu)) {
    const pendientes = l.filter((s) => !s.real && aMin(s.hora) >= minuto - PENDIENTE_MIN)
      .sort((a, b) => aMin(a.hora) - aMin(b.hora));
    const salieron = l.filter((s) => s.real).sort((a, b) => aMin(b.real) - aMin(a.real));
    const prox = pendientes[0];
    const ult = salieron[0];
    const base = prox ?? ult;
    if (!base) continue;
    buses[ppu] = {
      servicio: base.servicio,
      hora: base.hora,
      despacho: base.despacho ?? null,
      real: base.real ?? null,
      conductor: base.conductor ?? null,
      ...(prox && ult ? { salio: { servicio: ult.servicio, hora: ult.hora, real: ult.real } } : {}),
    };
  }
  return ordenado(buses);
}

/// "SRSC51 salió 10:06 · SRPK19 sale 10:41 (1040-R) · SRRX13 ya no figura" (sin nombres: el log es público).
function describirCambios(antes, ahora) {
  const l = [];
  for (const [ppu, b] of Object.entries(ahora)) {
    const a = antes?.[ppu];
    if (!a) l.push(b.real ? `${ppu} salió ${b.real}` : `${ppu} sale ${b.hora} (${b.servicio})`);
    else if (b.real && b.real !== a.real) l.push(`${ppu} salió ${b.real}`);
    else if (b.hora !== a.hora || b.servicio !== a.servicio) l.push(`${ppu} ahora sale ${b.hora} (${b.servicio})`);
    else if (b.salio?.real !== a.salio?.real && b.salio?.real) l.push(`${ppu} salió ${b.salio.real}`);
    else if (b.conductor !== a.conductor) l.push(`${ppu} cambió conductor`);
    else if (JSON.stringify(b) !== JSON.stringify(a)) l.push(`${ppu} cambió`);
  }
  for (const ppu of Object.keys(antes ?? {})) if (!ahora[ppu]) l.push(`${ppu} ya no figura`);
  return l.length > 6 ? [...l.slice(0, 6), `y ${l.length - 6} más`] : l;
}

// ------------------------------------------------------------------ errores

async function anotarError(db, e) {
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const dia = diaChile().replace(/-/g, '');
  await db.collection('errores').doc(`${dia}_robot_planillon`).set({
    origen: 'robot planillón', donde: 'GitHub Actions · sgdc-robot',
    mensaje: String(e.message).slice(0, 1500), stack: String(e.stack ?? '').slice(0, 4000),
    plataforma: 'GitHub', ultima: FieldValue.serverTimestamp(), ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'), veces: FieldValue.increment(1), resuelto: false,
  }, { merge: true }).catch(() => {});
}

const aMs = (t) => (t?.toMillis ? t.toMillis() : null);

// ------------------------------------------------------------------ motor

export async function correrPlanillon({
  db = null, probar = false, cada = 180, minutos = 55, vueltas = null, respetarHorario = true,
} = {}) {
  const usuario = process.env.ICR_USUARIO ?? '';
  const claveIcr = process.env.ICR_CLAVE ?? '';
  if (!usuario || !claveIcr) {
    console.log('Planillón: sin usuario/clave (ICR_USUARIO e ICR_CLAVE), se omite.');
    return;
  }
  const escribe = !probar && !!db;
  const FS = escribe ? await import('firebase-admin/firestore') : null;
  const ref = escribe ? db.doc('planillon/hoy') : null;
  const inicio = Date.now();
  let finMs = inicio + minutos * 60000;
  if (respetarHorario) finMs = Math.min(finMs, inicio + minutosHastaFin() * 60000);

  // Una lectura de cada cosa por corrida; después todo sigue en memoria.
  const previo = escribe ? (await ref.get()).data() ?? {} : {};
  const pausa = aMs(previo.pausaHasta);
  if (pausa && pausa > Date.now()) {
    // Espera dentro de la corrida (si saliera al tiro, el encadenado lanzaría otra al instante).
    console.log(`Planillón: en pausa hasta las ${horaChile(new Date(pausa))} (el ICR rechazó el login varias veces).`);
    if (vueltas != null) return;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(pausa, finMs) - Date.now())));
    if (Date.now() >= finMs - cada * 1000) {
      console.log('Planillón: terminó la corrida en pausa, sin intentar.');
      return;
    }
  }
  let flota;
  if (db) {
    const s = await db.collection('semaforoch').get();
    flota = new Set(s.docs.map((d) => ppuLimpia(d.data().ppu ?? d.id)).filter(Boolean));
    console.log(`Planillón: ${flota.size} buses del semáforo.`);
  } else {
    flota = null; // --probar sin Firestore: muestra todas las PPU
    console.log('Planillón: --probar sin Firestore, se muestran todas las PPU.');
  }

  let dia = diaChile();
  let salidas = previo.dia === dia ? { ...(previo.salidas ?? {}) } : {};
  let escrito = previo.dia === dia ? JSON.stringify(ordenado({ ok: previo.ok, error: previo.error ?? null, buses: previo.buses ?? {} })) : null;
  let busesEscritos = previo.dia === dia ? previo.buses ?? {} : {};
  let ultimaEscritura = aMs(previo.actualizado) ?? 0;
  let ultimoAviso = aMs(previo.avisoError) ?? 0;
  let escrituras = 0;
  let bloques = null;
  let rechazos = 0;
  let n = 0;
  const sesion = new SesionIcr(usuario, claveIcr);

  /// Lee los bloques que tocan y actualiza `salidas`. Devuelve el bloque actual (o null).
  const pasada = async () => {
    if (!sesion.dentro) {
      try {
        await sesion.entrar();
        rechazos = 0;
      } catch (e) {
        if (!esErrorDeRed(e)) rechazos++;
        e.login = true;
        throw e;
      }
    }
    if (!bloques) bloques = await sesion.bloques(fechaIcr());
    const minuto = minutoChile();
    const b = bloqueDeAhora(bloques, minuto);
    if (!b) return null;
    const leer = [b.actual, b.siguiente, minuto - b.actual.desde < ANTERIOR_MIN ? b.anterior : null].filter(Boolean);
    const nuevas = [];
    for (const servicio of SERVICIOS) {
      for (const bl of leer) {
        const r = await sesion.bloque(servicio, bl.id);
        nuevas.push({ servicio, bloque: bl.id, salidas: r.salidas });
      }
    }
    // Recién con todo leído se reemplaza: lo de esos bloques se borra y queda lo último (la PPU de una
    // salida puede cambiar; si una PPU ya no está en ninguna salida, desaparece).
    for (const { servicio, bloque, salidas: l } of nuevas) {
      for (const [k, s] of Object.entries(salidas)) if (s.servicio === servicio && s.bloque === bloque) delete salidas[k];
      for (const s of l) {
        if (!s.ppu || !s.hora || (flota && !flota.has(s.ppu))) continue;
        salidas[clave(s)] = {
          servicio, bloque, hora: s.hora, despacho: s.despacho, real: s.real, ppu: s.ppu, conductor: s.conductor,
        };
      }
    }
    return b.actual;
  };

  while (true) {
    const t0 = Date.now();
    n++;
    // Cambio de día: desde cero.
    if (diaChile() !== dia) {
      dia = diaChile();
      salidas = {};
      bloques = null;
      console.log(`[${horaChile()}] Planillón: día nuevo (${dia}), parte de cero.`);
    }
    let ok = true;
    let error = null;
    let actual = null;
    let fallo = null;
    try {
      try {
        actual = await pasada();
      } catch (e) {
        if (e.login && !esErrorDeRed(e) && rechazos >= MAX_LOGIN_RECHAZADO) throw e;
        // Reintento: si parecía sesión vencida (o falló el login), se vuelve a entrar.
        console.warn(`[${horaChile()}] Planillón: ${e.message} · reintento`);
        if (e.sesion || e.login) sesion.dentro = false;
        if (!esErrorDeRed(e)) bloques = null;
        actual = await pasada();
      }
    } catch (e) {
      ok = false;
      error = String(e.message).slice(0, 300);
      fallo = e;
      sesion.dentro = false;
      console.warn(`[${horaChile()}] Planillón: falló otra vez: ${e.message}`);
    }

    const buses = armarBuses(salidas);
    const firma = JSON.stringify(ordenado({ ok, error, buses }));
    const desde = Date.now() - ultimaEscritura;
    const cambio = firma !== escrito;
    const motivo = cambio && desde >= ESCRITURA_MIN_MS
      ? (ok ? `cambio: ${describirCambios(busesEscritos, buses).join(', ') || 'estado'}` : `error: ${error}`)
      : desde >= CONTROL_MS ? 'control (sin cambios, para que la app lo vea al día)' : null;

    // Aviso en ERRORES (máx. 1 por hora; las fallas de red no).
    let avisar = false;
    if (fallo && !esErrorDeRed(fallo) && Date.now() - ultimoAviso >= AVISO_ERROR_MS) {
      avisar = true;
      ultimoAviso = Date.now();
    }
    // Varios logins rechazados seguidos: pausa de 1 h (el respaldo no lo vuelve a intentar antes).
    const pausar = fallo?.login && !esErrorDeRed(fallo) && rechazos >= MAX_LOGIN_RECHAZADO;

    const resumen = `${actual ? `bloque ${actual.nombre}` : 'sin bloque'} · ${Object.keys(buses).length} buses con salida`;
    if ((motivo || avisar || pausar) && escribe) {
      await ref.set({
        actualizado: FS.FieldValue.serverTimestamp(),
        dia,
        ok,
        ...(error ? { error } : {}),
        ...(actual ? { bloque: actual.nombre } : {}),
        buses,
        salidas,
        ...(ultimoAviso ? { avisoError: FS.Timestamp.fromMillis(ultimoAviso) } : {}),
        ...(pausar ? { pausaHasta: FS.Timestamp.fromMillis(Date.now() + PAUSA_LOGIN_MS) } : {}),
      });
      if (avisar) await anotarError(db, fallo);
      escrituras++;
      escrito = firma;
      busesEscritos = buses;
      ultimaEscritura = Date.now();
      console.log(`[${horaChile()}] ${resumen} · ESCRIBIÓ #${escrituras} (${motivo ?? 'aviso de error'})`);
    } else if (motivo) {
      escrito = firma;
      busesEscritos = buses;
      ultimaEscritura = Date.now();
      console.log(`[${horaChile()}] ${resumen} · escribiría (${motivo}) [--probar: no escribe]`);
      if (n === 1) for (const [ppu, b] of Object.entries(buses)) {
        console.log(`  ${ppu}: ${b.servicio} ${b.hora} · despacho ${b.despacho ?? '—'} · real ${b.real ?? '—'}${b.salio ? ` · salió ${b.salio.real}` : ''}`);
      }
    } else {
      console.log(`[${horaChile()}] ${resumen} · no escribe (${cambio ? 'cambió, espera los 3 min' : 'sin cambios'})`);
    }
    if (pausar) {
      console.error(`Planillón: el ICR rechazó el login ${rechazos} veces seguidas; pausa de 1 h y termina la corrida.`);
      throw fallo;
    }

    if (vueltas != null && n >= vueltas) break;
    const espera = cada * 1000 - (Date.now() - t0);
    if (Date.now() + espera > finMs) break;
    await new Promise((r) => setTimeout(r, Math.max(0, espera)));
  }
  const dur = Math.round((Date.now() - inicio) / 60000);
  console.log(`Planillón: fin de la corrida · ${n} pasadas en ${dur} min · ${escrituras} escrituras${escribe ? '' : ' (simuladas, --probar)'}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const valor = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const conValor = new Set(['--cada', '--minutos']);
  const llave = args.find((a, i) => !a.startsWith('--') && !conValor.has(args[i - 1]));
  (async () => {
    const loop = args.includes('--loop');
    const siempre = args.includes('--siempre');
    if (loop && !siempre && !enHorario()) {
      console.log(`Planillón: fuera de horario (${horaChile()}): no se lee nada.`);
      return;
    }
    if (probar && !(process.env.ICR_USUARIO && process.env.ICR_CLAVE) && process.stdin.isTTY) {
      process.env.ICR_USUARIO = await preguntar('Usuario del ICR: ');
      process.env.ICR_CLAVE = await preguntar('Clave del ICR (no se ve): ', true);
    }
    let db = null;
    if (!probar) {
      const admin = (await import('firebase-admin')).default;
      const cred = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : JSON.parse(readFileSync(llave ?? 'serviceAccount.json', 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      db = admin.firestore();
    }
    try {
      await correrPlanillon({
        db, probar,
        cada: loop ? Math.max(60, Number(valor('--cada')) || 180) : 180,
        minutos: Math.max(1, Math.min(58, Number(valor('--minutos')) || 55)),
        vueltas: loop ? null : 1,
        respetarHorario: loop && !siempre,
      });
    } catch (e) {
      console.error('Falló planillón:', e.message);
      process.exit(1);
    }
  })();
}
