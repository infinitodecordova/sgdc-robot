// Planillón de despacho ICR → Firestore (planillon/hoy): a qué hora sale cada bus del semáforo,
// por qué servicio y con qué conductor (solo primer nombre + primer apellido; NUNCA el RUT).
//
// Usuario y clave NUNCA van en un archivo: variables ICR_USUARIO e ICR_CLAVE (secretos en GitHub).
// El repo es público y sus logs también: el log muestra PPU y horas, nunca nombres de conductores.
//
// Modo loop (workflow planillon.yml): una pasada cada 3 min durante ~55 min o hasta que termine el
// horario (HORARIO, hora de Chile). Fuera de horario sale al tiro.
//   node planillon_sync.mjs --loop --cada 180
// Cada pasada lee de los servicios de los dos sentidos (R: 1040-R, 1043-R y sus FTS, salen del terminal;
// I: 1040-I, 1043-I y sus FTS, vienen del cabezal) el bloque actual y el siguiente (y el anterior en los
// primeros 15 min del bloque). Sentido R va en buses.PPU con conductor; sentido I en buses.PPU.viene SIN
// conductor (la salida real del cabezal sale de digiCAR → salioDe).
// Escribe planillon/hoy SOLO si cambió algo, máximo 1 vez cada 3 min, más un control cada 15 min.
// Al cambiar de día parte de cero (sin historial).
// El ICR no anota la hora real y saca la salida cuando el bus sale (19-11): la hora real se toma de la
// salida del terminal que ve digiCAR (digicar/flota, solo cuando hay una salida esperándola, máx. cada 3 min)
// y una salida que el ICR saca después de su hora queda marcada `fuera` en vez de borrarse.
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
  CAMPO_SERVICIOS, SERVICIOS_I, SERVICIOS_R, SesionIcr, bloqueDeAhora, diaChile, esErrorDeRed, fechaIcr, minutoChile,
  sentidoDe,
} from './planillon_icr.mjs';

/// Horario del robot (hora de Chile, minutos desde medianoche). Cruza la medianoche: 05:00 → 00:30.
export const HORARIO = { desde: 5 * 60, hasta: 30 };

const ESCRITURA_MIN_MS = 3 * 60 * 1000 - 10000; // máx. 1 escritura cada ~3 min (10 s de holgura)
const CONTROL_MS = 15 * 60 * 1000; // aunque no cambie nada, para que la app lo vea vigente
const AVISO_ERROR_MS = 60 * 60 * 1000; // aviso en ERRORES: máximo 1 por hora
const ANTERIOR_MIN = 15; // en los primeros 15 min del bloque se relee el anterior
const PENDIENTE_MIN = 30; // una salida sin hora real se da por perdida 30 min después de su hora
const QUEDA_MIN = 15; // si el ICR saca una salida que ya tocaba (o falta menos que esto), se queda marcada "fuera"
const GPS_ANTES_MIN = 30; // la salida del terminal de digiCAR cuenta desde 30 min antes de la hora de despacho…
const GPS_DESPUES_MIN = 90; // …hasta 90 min después
const EN_CAMINO_MIN = 75; // un viaje cabezal → terminal que salió hace menos de esto sigue "en camino" (~53 min medidos)
const DIGICAR_MS = 3 * 60 * 1000 - 10000; // digicar/flota se lee máx. 1 vez cada ~3 min, y solo si hace falta
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

const vence = (s) => aMin(s.despacho ?? s.hora); // hora en que debe salir

/// Pendiente: sin hora real, el ICR todavía la muestra y no han pasado 30 min de su hora de despacho.
const pendiente = (s, minuto) => !s.real && !s.fuera && vence(s) >= minuto - PENDIENTE_MIN;

/**
 * Arma buses a partir de las salidas del día:
 *   { PPU: { servicio, hora, despacho, real, conductor, gps?, salio?, viene? } }
 * Sentido R (sale del terminal), como siempre:
 * - Manda la próxima salida pendiente; si además ya salió antes, esa queda en `salio`.
 * - Si no le queda ninguna pendiente, va la última que salió (con `real`).
 * Sentido I (viene del cabezal al terminal), en `viene` = { servicio, hora, despacho, real, gps? } SIN conductor:
 * - La que salió del cabezal hace menos de 75 min (va en camino); si no, la próxima pendiente.
 * Un bus que solo tiene salida I queda como { viene }.
 */
export function armarBuses(salidas, minuto = minutoChile()) {
  const porPpu = {};
  for (const s of Object.values(salidas)) (porPpu[s.ppu] ??= []).push(s);
  const buses = {};
  for (const [ppu, todas] of Object.entries(porPpu)) {
    const ida = todas.filter((s) => sentidoDe(s.servicio) === 'R');
    const vuelta = todas.filter((s) => sentidoDe(s.servicio) === 'I');
    const b = {};

    const prox = ida.filter((s) => pendiente(s, minuto)).sort((x, y) => vence(x) - vence(y))[0];
    const ult = ida.filter((s) => s.real).sort((x, y) => aMin(y.real) - aMin(x.real))[0];
    const base = prox ?? ult;
    if (base) {
      Object.assign(b, {
        servicio: base.servicio,
        hora: base.hora,
        despacho: base.despacho ?? null,
        real: base.real ?? null,
        conductor: base.conductor ?? null,
        ...(base.gps ? { gps: true } : {}),
        ...(prox && ult ? { salio: { servicio: ult.servicio, hora: ult.hora, real: ult.real, ...(ult.gps ? { gps: true } : {}) } } : {}),
      });
    }

    const enCamino = vuelta.filter((s) => s.real && minuto - aMin(s.real) <= EN_CAMINO_MIN && minuto >= aMin(s.real) - 5)
      .sort((x, y) => aMin(y.real) - aMin(x.real))[0];
    const viene = enCamino ?? vuelta.filter((s) => pendiente(s, minuto)).sort((x, y) => vence(x) - vence(y))[0];
    if (viene) {
      b.viene = {
        servicio: viene.servicio, hora: viene.hora, despacho: viene.despacho ?? null, real: viene.real ?? null,
        ...(viene.gps ? { gps: true } : {}),
      };
    }
    if (Object.keys(b).length) buses[ppu] = b;
  }
  return ordenado(buses);
}

/**
 * Reemplaza en `salidas` lo de un bloque recién leído. Lo último manda (la PPU de una salida puede cambiar),
 * pero el ICR saca las salidas cuando el bus sale (visto el 19-11): si una salida desaparece y su hora ya
 * pasó o falta poco (< 15 min), se queda marcada `fuera` en vez de borrarse. La hora real que ya se sacó del
 * GPS se conserva mientras el ICR no traiga la suya. Devuelve cuántas quedaron "fuera" nuevas.
 */
export function fusionarBloque(salidas, servicio, bloque, lista, minuto, flota = null) {
  const antes = {};
  for (const [k, s] of Object.entries(salidas)) {
    if (s.servicio === servicio && s.bloque === bloque) {
      antes[k] = s;
      delete salidas[k];
    }
  }
  for (const s of lista) {
    if (!s.ppu || !s.hora || (flota && !flota.has(s.ppu))) continue;
    const k = clave({ servicio, hora: s.hora });
    const a = antes[k];
    const mismo = a && a.ppu === s.ppu;
    salidas[k] = {
      servicio, bloque, hora: s.hora, despacho: s.despacho, ppu: s.ppu,
      conductor: sentidoDe(servicio) === 'I' ? null : s.conductor, // sentido I: sin conductor
      real: s.real ?? (mismo ? a.real ?? null : null),
      ...(!s.real && mismo && a.gps ? { gps: true, realMs: a.realMs } : {}),
    };
    delete antes[k];
  }
  let fuera = 0;
  for (const [k, a] of Object.entries(antes)) {
    // Ya no está en el ICR (ni con otra PPU en la misma salida).
    if (salidas[k]) continue;
    if (vence(a) <= minuto + QUEDA_MIN) {
      if (!a.fuera) fuera++;
      salidas[k] = { ...a, fuera: true };
    }
  }
  return fuera;
}

/// ¿Hay alguna salida esperando hora real que digiCAR podría dar? (para no leer digicar/flota de más)
export function faltaHoraReal(salidas, minuto) {
  return Object.values(salidas).some((s) => !s.real && vence(s) <= minuto + 5 && vence(s) >= minuto - GPS_DESPUES_MIN);
}

/**
 * Completa la hora real de un sentido con lo que vio digiCAR (`digicar/flota` → buses):
 *   R: la salida del terminal (salida.fecha) · I: la salida del cabezal (salioDe.fecha, si es un cabezal).
 * Cuenta si salió entre 30 min antes y 90 min después de su hora de despacho, el mismo día. Si un bus tiene
 * varias salidas pendientes, la salida del GPS va a la de hora más cercana, y nunca la misma a dos.
 * @param gps { PPU: milisegundos de esa salida }
 * Devuelve [ 'SRSC51 10:06', ... ] para el log.
 */
export function completarConGps(salidas, gps, dia, sentido = 'R') {
  const hechas = [];
  const porPpu = {};
  for (const s of Object.values(salidas)) if (sentidoDe(s.servicio) === sentido) (porPpu[s.ppu] ??= []).push(s);
  for (const [ppu, l] of Object.entries(porPpu)) {
    const ms = gps[ppu];
    if (!ms || diaChile(new Date(ms)) !== dia) continue;
    if (l.some((s) => s.realMs === ms)) continue; // esa salida del terminal ya se usó
    const m = minutoChile(new Date(ms));
    const cand = l.filter((s) => !s.real && m >= vence(s) - GPS_ANTES_MIN && m <= vence(s) + GPS_DESPUES_MIN)
      .sort((a, b) => Math.abs(vence(a) - m) - Math.abs(vence(b) - m));
    const s = cand[0];
    if (!s) continue;
    s.real = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    s.gps = true;
    s.realMs = ms;
    hechas.push(`${ppu} ${s.real}`);
  }
  return hechas;
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
  // Sentido I (viene del cabezal).
  for (const [ppu, b] of Object.entries(ahora)) {
    const a = antes?.[ppu]?.viene;
    const v = b.viene;
    if (!v) continue;
    if (!a || a.hora !== v.hora || a.servicio !== v.servicio) l.push(`${ppu} viene ${v.despacho ?? v.hora} (${v.servicio})`);
    else if (v.real && v.real !== a.real) l.push(`${ppu} salió del cabezal ${v.real}`);
  }
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
  let ultimoDigicar = 0;
  let servicios = null; // R e I, se piden a la página una vez por corrida
  let avisoBloque = false;
  let lecturasDigicar = 0;
  let notas = []; // lo que pasó en la pasada, para el log
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
    // Servicios de los dos sentidos, una vez por corrida (si la página no responde, los de siempre).
    if (!servicios) {
      servicios = [];
      for (const [sentido, campo] of Object.entries(CAMPO_SERVICIOS)) {
        let l = [];
        try {
          l = await sesion.servicios(campo);
        } catch (e) {
          if (e.sesion) throw e;
        }
        if (!l.length) l = sentido === 'I' ? SERVICIOS_I : SERVICIOS_R;
        servicios.push(...l);
      }
      console.log(`Planillón: servicios ${servicios.join(', ')}.`);
    }
    const minuto = minutoChile();
    const b = bloqueDeAhora(bloques, minuto);
    if (!b) return null;
    const leer = [b.actual, b.siguiente, minuto - b.actual.desde < ANTERIOR_MIN ? b.anterior : null].filter(Boolean);
    const nuevas = [];
    for (const servicio of servicios) {
      for (const bl of leer) {
        const r = await sesion.bloque(servicio, bl.id);
        // Si el ICR devolvió otro bloque que el pedido, no se mezcla (quedaría con la etiqueta equivocada).
        if (r.id !== bl.id) {
          if (!avisoBloque) console.warn(`[${horaChile()}] Planillón: pedí el bloque ${bl.id} de ${servicio} y llegó el ${r.id}; se ignora.`);
          avisoBloque = true;
          continue;
        }
        nuevas.push({ servicio, bloque: bl.id, salidas: r.salidas });
      }
    }
    // Recién con todo leído se reemplaza (ver fusionarBloque).
    let fuera = 0;
    for (const { servicio, bloque, salidas: l } of nuevas) fuera += fusionarBloque(salidas, servicio, bloque, l, minuto, flota);
    if (fuera) notas.push(`${fuera} salida${fuera === 1 ? '' : 's'} ya no figura${fuera === 1 ? '' : 'n'} en el ICR`);
    // Hora real desde digiCAR (el ICR no la anota): solo si hace falta, máx. 1 lectura cada ~3 min.
    if (db && faltaHoraReal(salidas, minuto) && Date.now() - ultimoDigicar >= DIGICAR_MS) {
      ultimoDigicar = Date.now();
      try {
        const buses = (await db.doc('digicar/flota').get()).data()?.buses ?? {};
        const delTerminal = {}; // R: salida del terminal
        const delCabezal = {}; // I: salida de un cabezal
        for (const [ppu, v] of Object.entries(buses)) {
          const ms = v?.salida?.fecha?.toMillis?.();
          if (ms) delTerminal[ppuLimpia(ppu)] = ms;
          const c = v?.salioDe;
          const msc = c?.fecha?.toMillis?.();
          if (msc && /cabezal/i.test(String(c.lugar ?? ''))) delCabezal[ppuLimpia(ppu)] = msc;
        }
        lecturasDigicar++;
        const r = completarConGps(salidas, delTerminal, dia, 'R');
        const i = completarConGps(salidas, delCabezal, dia, 'I');
        if (r.length) notas.push(`salida real por GPS: ${r.join(', ')}`);
        if (i.length) notas.push(`salida del cabezal por GPS: ${i.join(', ')}`);
      } catch (e) {
        console.warn(`[${horaChile()}] Planillón: no se pudo leer digicar/flota:`, e.message);
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
    notas = [];
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

    const resumen = `${actual ? `bloque ${actual.nombre}` : 'sin bloque'} · ${Object.keys(buses).length} buses con salida` +
      `${notas.length ? ` · ${notas.join(' · ')}` : ''}`;
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
  console.log(`Planillón: fin de la corrida · ${n} pasadas en ${dur} min · ${escrituras} escrituras · ` +
    `${lecturasDigicar} lecturas de digiCAR${escribe ? '' : ' (simuladas, --probar)'}.`);
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
