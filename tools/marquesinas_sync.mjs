// Trae en vivo el estado de las pistolas de Camilo Henríquez (página de marquesinas de STP)
// y lo deja en Firestore (marquesinas/estado): qué bus está en cada pistola, si está
// cargando o ya terminó, % de carga, kWh y tiempo.
//
// Usuario y clave NUNCA van en un archivo: variables MARQ_USUARIO y MARQ_CLAVE (secretos en GitHub).
//
// Modo loop (workflow marquesinas.yml): lee cada 30 s durante ~55 min o hasta que termine la
// ventana de turno (08:15–18:15 y 21:45–07:45, hora de Chile). Fuera de horario sale al tiro.
//   node marquesinas_sync.mjs --loop --cada 30
// Escribe en Firestore AL TIRO si cambia algo importante (estado de una pistola, bus que se conecta
// o desconecta, motivo de deshabilitada); si solo cambia SoC/tiempo/temperatura, máximo una vez cada
// 2 min; y una escritura de control cada 5 min aunque no cambie nada (la app da el patio por
// desactualizado a los 20 min). Tope: ~150 escrituras por corrida; pasado el tope, cada 2 min.
//
// Probar en el PC (no sube nada; si faltan, pide usuario y clave):
//   node marquesinas_sync.mjs --probar                       una lectura
//   node marquesinas_sync.mjs --probar --loop --cada 30 --minutos 3 --siempre
//                                                            loop de 3 min, aunque sea fuera de horario
// Ver los datos crudos de algunas pistolas (para ajustar estados que no calzan con la página):
//   node marquesinas_sync.mjs --probar --crudo A5-L,A6-L,B11-R

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const BASE = 'http://186.67.130.114:8091/api/v2';
const TERMINAL = 6; // Camilo Henríquez

// Escrituras en Firestore (cada una = 1 lectura por celular con la app abierta).
const ESCRITURA_SOC_MS = 2 * 60 * 1000; // si solo cambia SoC/tiempo/temperatura (sube ~1 % cada 2 min)
const ESCRITURA_CONTROL_MS = 5 * 60 * 1000; // aunque no cambie nada, para que la app lo vea vigente
const TOPE_ESCRITURAS = 150; // por corrida
const ESCRITURA_TOPE_MS = 2 * 60 * 1000; // pasado el tope
const CURVA_MS = 10 * 60 * 1000; // las muestras de la curva de carga se guardan juntas cada 10 min
const MAX_FALLOS_LOGIN = 3;
const MAX_FALLOS_LECTURA = 10;

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

async function pedir(url, opciones = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    return await fetch(url, { ...opciones, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function entrar(usuario, clave) {
  const r = await pedir(`${BASE}/usuarios/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({ username: usuario, password: clave }),
  });
  if (!r.ok) throw new Error(`Marquesinas respondió ${r.status} al iniciar sesión: usuario o clave de marquesinas incorrectos`);
  const j = await r.json();
  if (!j.token) throw new Error(`Marquesinas no devolvió token al iniciar sesión: ${j.msg ?? ''}`);
  return j.token;
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/// estado 3 = cargando; 6 = ya cargó y sigue conectado (Operativo en la página);
/// con bus asignado pero sin cargar = reservada; el resto según connectorStatus.
/// Mismos estados y colores que la página: disponible (verde), reservado (amarillo),
/// cargando (azul), ocupado (rojo), operativo (morado: ya cargó, desconectado y listo para ruta),
/// deshabilitada (naranjo, código 5).
function estadoDe(p) {
  const s = String(p.connectorStatus ?? '').toLowerCase();
  // 5 = deshabilitada (naranjo en la página), aunque connectorStatus diga "Disponible".
  // También si su último reporte de revisión la deshabilitó.
  if (p.estado === 5 || p.ultimoReporteInfo?.deshabilita === 1) return 'deshabilitada';
  if (p.estado === 3) return 'cargando';
  if (p.estado === 6) return 'operativo';
  if (s.includes('ocup')) return 'ocupado';
  if (s.includes('reserv') || p.estado === 2) return 'reservado';
  if (p.bus?.ppu) return 'reservado'; // la pistola tiene bus asignado, pero todavía no carga
  if (s.includes('carg')) return 'cargando';
  if (s.includes('reserv')) return 'reservado';
  if (s.includes('ocup')) return 'ocupado';
  if (s.includes('dispon')) return 'disponible';
  return s || 'desconocido';
}

/// Error de la página con su código HTTP (401 = token vencido).
class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

/// Una lectura de la página: { pistolas, buses } (sin desde/ritmo todavía).
async function leerPistolas(token, crudo = []) {
  const r = await pedir(`${BASE}/marquesinas/estacion/${TERMINAL}`, {
    headers: { Accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ErrorHttp(r.status, `Marquesinas respondió ${r.status} al leer las pistolas`);
  const j = await r.json();

  // Datos crudos de las pistolas pedidas, tal como los entrega la página (sin tocar nada).
  if (crudo.length) {
    const quiero = new Set(crudo.map((x) => x.toUpperCase()));
    for (const m of j.marquesinas ?? []) {
      const { cargadores, ...restoM } = m;
      for (const c of cargadores ?? []) {
        const { pistolas: ps, ...restoC } = c;
        for (const p of ps ?? []) {
          if (!quiero.has(String(p.nombre).toUpperCase())) continue;
          console.log(`\n===== ${p.nombre} =====`);
          console.log('pistola:', JSON.stringify(p, null, 2));
          console.log('cargador:', JSON.stringify(restoC, null, 2));
          console.log('marquesina:', JSON.stringify(restoM, null, 2));
        }
      }
    }
  }

  const pistolas = {};
  const buses = {};
  for (const m of j.marquesinas ?? []) {
    for (const c of m.cargadores ?? []) {
      for (const p of c.pistolas ?? []) {
        const ppu = String(p.bus?.ppu ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const dato = {
          estado: estadoDe(p),
          ppu: ppu || null,
          soc: num(p.soc),
          kwh: num(p.energiaCarga),
          tiempo: p.tiempoCarga ?? null, // "01:12" = horas:minutos cargando
          temperatura: num(p.temperatura),
          bloqueada: p.enInspeccion === 1,
          // Motivo si un reporte de revisión la deshabilitó ("REVISION DE PISTOLA · P014 P019").
          motivo: p.ultimoReporteInfo?.deshabilita === 1
            ? [p.ultimoReporteInfo.titulo, p.ultimoReporteInfo.descripcion].filter(Boolean).join(' · ').slice(0, 120)
            : null,
          codigo: p.estado ?? null, // código original de la página, por si hay que ajustar
        };
        pistolas[p.nombre] = dato;
        if (ppu) buses[ppu] = { pistola: p.nombre, ...dato };
      }
    }
  }
  return { pistolas, buses };
}

// ------------------------------------------------------------------ desde / ritmo / curva
// Por dentro las fechas van en milisegundos; en Firestore se guardan como Timestamp (igual que antes).

const aMs = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : null);

/// Lo que quedó guardado en Firestore, pasado a milisegundos.
function desdeFirestore(buses) {
  const r = {};
  for (const [ppu, b] of Object.entries(buses ?? {})) {
    r[ppu] = {
      ...b,
      desde: aMs(b.desde),
      ref: b.ref && aMs(b.ref.t) != null ? { soc: b.ref.soc, t: aMs(b.ref.t) } : null,
    };
  }
  return r;
}

/// Completa cada bus con "desde", "ref" y "ritmo" comparando con la lectura anterior ([antes]).
/// Devuelve las muestras para la curva de carga: [tramo de 5 %, minutos, % subidos].
/// El ritmo se mide contra una referencia de hace ≥ 4 min, así que leer más seguido no da más muestras.
function completar(buses, antes, ahoraMs, escala = 1) {
  const muestras = [];
  for (const [ppu, b] of Object.entries(buses)) {
    const a = antes[ppu];
    const igual = a && a.pistola === b.pistola && a.estado === b.estado;
    // "desde": cuándo quedó el bus en ese estado y pistola (para avisar si lleva rato reservado sin cargar).
    b.desde = igual && a.desde ? a.desde : ahoraMs;
    // Ritmo de carga (% por minuto): contra un punto de referencia de hace ~4–15 min
    // (el % sube de a 1: tramos cortos darían ritmos muy saltones).
    if (igual && b.estado === 'cargando' && b.soc != null) {
      const ref = a.ref?.t != null ? a.ref : null;
      const min = ref ? (ahoraMs - ref.t) / (60000 * escala) : null;
      if (ref && min >= 4 && min <= 15) {
        const sube = b.soc - ref.soc;
        if (sube >= 0 && sube <= 25) {
          b.ritmo = Math.round((sube / min) * 1000) / 1000;
          b.ritmoSoc = Math.round((ref.soc + b.soc) / 2);
          muestras.push([Math.min(95, Math.floor(((ref.soc + b.soc) / 2) / 5) * 5), min, sube]);
        }
        b.ref = { soc: b.soc, t: ahoraMs };
      } else if (ref && min < 4) {
        b.ref = ref;
      } else {
        b.ref = { soc: b.soc, t: ahoraMs };
      }
    }
    if (b.ritmo == null && igual && a.ritmo != null) {
      b.ritmo = a.ritmo;
      b.ritmoSoc = a.ritmoSoc ?? null;
    }
  }
  return muestras;
}

/// Suma muestras a la curva (los datos viejos pesan menos), igual que antes.
function sumarCurva(curva, muestras) {
  for (const [t, min, pct] of muestras) {
    const c = curva[t] ?? { min: 0, pct: 0, n: 0 };
    curva[t] = {
      min: Math.round((c.min * 0.98 + min) * 100) / 100,
      pct: Math.round((c.pct * 0.98 + pct) * 100) / 100,
      n: (c.n ?? 0) + 1,
    };
  }
}

/// Buses para guardar: las fechas en Timestamp.
function paraFirestore(buses, Timestamp) {
  const r = {};
  for (const [ppu, b] of Object.entries(buses)) {
    const { desde, ref, ...resto } = b;
    r[ppu] = {
      ...resto,
      desde: Timestamp.fromMillis(desde),
      ...(ref ? { ref: { soc: ref.soc, t: Timestamp.fromMillis(ref.t) } } : {}),
    };
  }
  return r;
}

// ------------------------------------------------------------------ ¿qué cambió?

/// Lo importante de cada pistola: estado, bus conectado y motivo.
const firmaImportante = (pistolas) =>
  Object.fromEntries(Object.entries(pistolas).map(([n, p]) => [n, `${p.estado}|${p.ppu ?? ''}|${p.motivo ?? ''}|${p.bloqueada}`]));
/// Lo menor: SoC, kWh, tiempo y temperatura.
const firmaMenor = (pistolas) =>
  JSON.stringify(Object.entries(pistolas).map(([n, p]) => [n, p.soc, p.kwh, p.tiempo, p.temperatura]));

/// "B9-L cargando→operativo, A2-R conectó SRPK10" (cambios importantes respecto a lo último escrito).
function describirCambios(antes, ahora) {
  if (!antes) return ['primera lectura'];
  const l = [];
  for (const [n, f] of Object.entries(ahora)) {
    const a = antes[n];
    if (a === f) continue;
    const [e0, ppu0, m0] = (a ?? '|||').split('|');
    const [e1, ppu1, m1] = f.split('|');
    if (ppu0 !== ppu1) l.push(ppu1 ? `${n} conectó ${ppu1}` : `${n} desconectó ${ppu0}`);
    if (e0 !== e1) l.push(`${n} ${e0 || '?'}→${e1}`);
    if (m0 !== m1 && m1) l.push(`${n} motivo: ${m1}`);
  }
  return l.length ? l : ['cambio en pistolas'];
}

// ------------------------------------------------------------------ horario

/// Hora de Chile como número HHMM.
function hmChile(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 100 + Number(p.minute);
}

/// Igual que el horario de digiCAR: 08:15–18:15 y 21:45–07:45 (hora de Chile).
export function enHorario(d = new Date()) {
  const hm = hmChile(d);
  return (hm >= 815 && hm < 1815) || hm >= 2145 || hm < 745;
}

/// Minutos que faltan para que termine la ventana de turno actual (0 si está fuera).
function minutosHastaFinVentana(d = new Date()) {
  const hm = hmChile(d);
  const min = Math.floor(hm / 100) * 60 + (hm % 100);
  if (hm >= 815 && hm < 1815) return 18 * 60 + 15 - min;
  if (hm >= 2145) return 24 * 60 - min + 7 * 60 + 45;
  if (hm < 745) return 7 * 60 + 45 - min;
  return 0;
}

const horaChile = (d = new Date()) =>
  d.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false });

// ------------------------------------------------------------------ errores

async function anotarError(db, e) {
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).replace(/-/g, '');
  await db.collection('errores').doc(`${dia}_robot_marquesinas`).set({
    origen: 'robot marquesinas', donde: 'GitHub Actions · sgdc-robot',
    mensaje: String(e.message).slice(0, 1500), stack: String(e.stack ?? '').slice(0, 4000),
    plataforma: 'GitHub', ultima: FieldValue.serverTimestamp(), ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'), veces: FieldValue.increment(1), resuelto: false,
  }, { merge: true }).catch(() => {});
}

// ------------------------------------------------------------------ motor

/**
 * Lee las pistolas varias veces y decide cuándo escribir en Firestore.
 * @param db Firestore (null con --probar: no escribe nada, solo muestra qué haría)
 * @param cada segundos entre lecturas
 * @param minutos duración máxima de la corrida
 * @param vueltas máximo de lecturas (null = sin límite)
 * @param respetarHorario corta al terminar la ventana de turno
 * @param escala solo para pruebas: acelera todos los tiempos (0.01 = 100 veces más rápido)
 */
export async function correrMarquesinas({
  db = null, probar = false, crudo = [], cada = 30, minutos = 55, vueltas = null, respetarHorario = true, escala = 1,
} = {}) {
  const T = {
    soc: ESCRITURA_SOC_MS * escala, control: ESCRITURA_CONTROL_MS * escala,
    tope: ESCRITURA_TOPE_MS * escala, curva: CURVA_MS * escala, cada: cada * 1000 * escala, min: 60000 * escala,
  };
  const usuario = process.env.MARQ_USUARIO ?? '';
  const clave = process.env.MARQ_CLAVE ?? '';
  if (!usuario || !clave) {
    console.log('Marquesinas: sin usuario/clave (MARQ_USUARIO y MARQ_CLAVE), se omite.');
    return;
  }
  const escribe = !probar && !!db;
  const inicio = Date.now();
  let finMs = inicio + minutos * T.min;
  if (respetarHorario) finMs = Math.min(finMs, inicio + minutosHastaFinVentana() * T.min);

  const FS = escribe ? await import('firebase-admin/firestore') : null;
  const refEstado = escribe ? db.doc('marquesinas/estado') : null;
  const refCurva = escribe ? db.doc('config/curvaCarga') : null;

  // Lo último guardado (una sola lectura por corrida; después todo sigue en memoria).
  const previo = escribe ? (await refEstado.get()).data() ?? {} : {};
  let antes = desdeFirestore(previo.buses);
  let curva = null; // se lee recién cuando haya muestras
  let muestrasPendientes = [];
  let ultimaCurva = inicio;

  let firmaEscritaImp = previo.pistolas ? firmaImportante(previo.pistolas) : null;
  let firmaEscritaMenor = previo.pistolas ? firmaMenor(previo.pistolas) : null;
  let ultimaEscritura = aMs(previo.actualizado) ?? 0;
  let escrituras = 0;
  let avisoTope = false;

  let token = null;
  let fallosLogin = 0;
  let fallosLectura = 0;
  let n = 0;

  const guardarCurva = async (motivo) => {
    if (!escribe || !muestrasPendientes.length) return;
    if (!curva) curva = (await refCurva.get()).data()?.tramos ?? {};
    sumarCurva(curva, muestrasPendientes);
    await refCurva.set({ tramos: curva, actualizado: FS.FieldValue.serverTimestamp() });
    console.log(`Marquesinas: curva de carga actualizada con ${muestrasPendientes.length} mediciones (${motivo}).`);
    muestrasPendientes = [];
    ultimaCurva = Date.now();
  };

  while (true) {
    const t0 = Date.now();
    n++;
    try {
      if (!token) {
        try {
          token = await entrar(usuario, clave); // el token dura ~2 h: se reusa entre lecturas
          fallosLogin = 0;
        } catch (e) {
          fallosLogin++;
          e.login = true;
          throw e;
        }
      }
      let lectura;
      try {
        lectura = await leerPistolas(token, n === 1 ? crudo : []);
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          token = null; // venció: a la próxima vuelve a iniciar sesión
          e.vencido = true;
        }
        throw e;
      }
      fallosLectura = 0;
      const { pistolas, buses } = lectura;
      const ahoraMs = Date.now();
      muestrasPendientes.push(...completar(buses, antes, ahoraMs, escala));
      antes = buses;

      const cargando = Object.values(pistolas).filter((p) => p.estado === 'cargando').length;
      const resumen = `${Object.keys(pistolas).length} pistolas, ${cargando} cargando, ${Object.keys(buses).length} conectados`;
      if (n === 1 && !escribe) {
        console.log(`Marquesinas: ${resumen}.`);
        for (const [ppu, b] of Object.entries(buses)) {
          console.log(`  ${ppu} · ${b.pistola} · ${b.estado} (código ${b.codigo}) · ${b.soc ?? '-'}% · ${b.kwh ?? '-'} kWh · ${b.tiempo ?? ''}`);
        }
      }

      // ¿Escribir ahora?
      const fImp = firmaImportante(pistolas);
      const fMenor = firmaMenor(pistolas);
      const cambioImp = JSON.stringify(fImp) !== JSON.stringify(firmaEscritaImp);
      const cambioMenor = fMenor !== firmaEscritaMenor;
      const desdeUltima = ahoraMs - ultimaEscritura;
      let motivo = null;
      let espera = '';
      if (escrituras >= TOPE_ESCRITURAS) {
        if (!avisoTope) {
          console.log(`[${horaChile()}] Marquesinas: llegó al tope de ${TOPE_ESCRITURAS} escrituras; desde ahora escribe cada 2 min.`);
          avisoTope = true;
        }
        if (desdeUltima >= T.tope) {
          motivo = cambioImp ? `tope · cambio de estado: ${describirCambios(firmaEscritaImp, fImp).join(', ')}`
            : cambioMenor ? 'tope · SoC' : 'tope · control';
        } else {
          espera = 'tope: espera 2 min';
        }
      } else if (cambioImp) {
        motivo = `cambio de estado: ${describirCambios(firmaEscritaImp, fImp).join(', ')}`;
      } else if (cambioMenor && desdeUltima >= T.soc) {
        motivo = 'SoC';
      } else if (desdeUltima >= T.control) {
        motivo = 'control (sin cambios, para que la app lo vea al día)';
      } else {
        espera = cambioMenor ? `SoC cambió, espera ${Math.ceil((T.soc - desdeUltima) / 1000 / escala)} s` : 'sin cambios';
      }

      if (motivo && escribe) {
        await refEstado.set({
          pistolas,
          buses: paraFirestore(buses, FS.Timestamp),
          actualizado: FS.FieldValue.serverTimestamp(),
        });
        escrituras++;
        ultimaEscritura = ahoraMs;
        firmaEscritaImp = fImp;
        firmaEscritaMenor = fMenor;
        console.log(`[${horaChile()}] ${resumen} · ESCRIBIÓ #${escrituras} (${motivo})`);
      } else if (motivo) {
        // --probar: muestra qué haría, sin escribir.
        ultimaEscritura = ahoraMs;
        firmaEscritaImp = fImp;
        firmaEscritaMenor = fMenor;
        escrituras++;
        console.log(`[${horaChile()}] ${resumen} · escribiría (${motivo}) [--probar: no escribe]`);
      } else {
        console.log(`[${horaChile()}] ${resumen} · no escribe (${espera})`);
      }

      if (Date.now() - ultimaCurva >= T.curva) await guardarCurva('cada 10 min');
    } catch (e) {
      let fatal;
      if (e.login) {
        console.warn(`[${horaChile()}] Marquesinas: falló el inicio de sesión (${fallosLogin}/${MAX_FALLOS_LOGIN}):`, e.message);
        fatal = fallosLogin >= MAX_FALLOS_LOGIN; // 3 seguidas: se avisa en ERRORES y termina
      } else {
        fallosLectura++;
        console.warn(`[${horaChile()}] Marquesinas: ${e.vencido ? 'el token venció' : 'falló la lectura'} ` +
          `(${fallosLectura}/${MAX_FALLOS_LECTURA}):`, e.message);
        fatal = fallosLectura >= MAX_FALLOS_LECTURA;
      }
      // Con una sola lectura pedida (sin --loop) se avisa al tiro, como antes.
      const ultima = vueltas != null && n >= vueltas && !(e.vencido && fallosLectura === 1);
      if (fatal || ultima) {
        await guardarCurva('antes de salir').catch(() => {});
        throw e;
      }
      // Token vencido por primera vez: vuelve a entrar al tiro, sin esperar los 30 s.
      if (e.vencido && fallosLectura === 1) continue;
    }

    if (vueltas != null && n >= vueltas) break;
    if (Date.now() + T.cada > finMs) break;
    await new Promise((r) => setTimeout(r, Math.max(0, T.cada - (Date.now() - t0))));
  }

  await guardarCurva('al terminar');
  const dur = Math.round((Date.now() - inicio) / T.min);
  console.log(`Marquesinas: fin de la corrida · ${n} lecturas en ${dur} min · ${escrituras} escrituras` +
    `${escribe ? '' : ' (simuladas, --probar)'}.`);
}

/// Una sola lectura (compatibilidad: así funcionaba antes).
export async function sincronizarMarquesinas({ db = null, probar = false, crudo = [] } = {}) {
  return correrMarquesinas({ db, probar, crudo, vueltas: 1, respetarHorario: false });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const valor = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const conValor = new Set(['--crudo', '--cada', '--minutos', '--vueltas']);
  const llave = args.find((a, i) => !a.startsWith('--') && !conValor.has(args[i - 1]));
  (async () => {
    const loop = args.includes('--loop');
    const siempre = args.includes('--siempre');
    // Fuera de horario sale al tiro sin leer nada (salvo --siempre, o una lectura suelta para probar).
    if (loop && !siempre && !enHorario()) {
      console.log(`Marquesinas: fuera de horario (${horaChile()}): no se lee nada.`);
      return;
    }
    if (probar && !(process.env.MARQ_USUARIO && process.env.MARQ_CLAVE) && process.stdin.isTTY) {
      process.env.MARQ_USUARIO = await preguntar('Usuario de marquesinas: ');
      process.env.MARQ_CLAVE = await preguntar('Clave de marquesinas (no se ve): ', true);
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
      const crudo = valor('--crudo') ? valor('--crudo').split(',') : [];
      if (loop) {
        await correrMarquesinas({
          db, probar, crudo,
          cada: Math.max(10, Number(valor('--cada')) || 30),
          minutos: Math.max(1, Math.min(58, Number(valor('--minutos')) || 55)),
          respetarHorario: !siempre,
        });
      } else {
        // Sin --loop: --vueltas N lecturas, una por minuto (como antes); sin nada, una sola.
        const v = Number(valor('--vueltas')) || 1;
        await correrMarquesinas({
          db, probar, crudo, cada: 60, minutos: 5, vueltas: Math.max(1, Math.min(5, v)), respetarHorario: false,
        });
      }
    } catch (e) {
      console.error('Falló marquesinas:', e.message);
      await anotarError(db, e);
      process.exit(1);
    }
  })();
}
