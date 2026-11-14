// Trae el SoC real de los buses de Camilo Henríquez desde digiCAR (ThingsBoard)
// y lo deja en Firestore (colección "digicar", un documento por PPU).
//
// Los tokens de digiCAR NUNCA van en un archivo: se pasan por variables de entorno.
//   DIGICAR_REFRESH_TOKEN: el "refresh_token" de la sesión (dura 7 días y el robot lo renueva solo).
//   DIGICAR_TOKEN: el "jwt_token" (dura ~2 h; solo para probar).
//
// Probar en el PC (no sube nada, solo muestra):
//   read -s DIGICAR_REFRESH_TOKEN && export DIGICAR_REFRESH_TOKEN   (pega y Enter; no se ve)
//   node digicar_sync.mjs --probar
//
// Subir a Firestore:
//   node digicar_sync.mjs serviceAccount.json
//
// En GitHub Actions: secretos DIGICAR_TOKEN y FIREBASE_SERVICE_ACCOUNT.

import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BASE = 'https://visual.digicar.cl';
const AVISAR_VENCE_DIAS = 15;

const ppuClave = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

const coord = (v) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/// Distancia en metros entre dos puntos.
function metros(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const RADIO_TERMINAL = 350; // metros desde el centro del terminal

/// Lugares fijos donde puede estar un bus. tipo 'taller': todo bus ahí está en taller.
/// Se pueden agregar más en Firestore (config/lugares → lista: [{nombre, lat, lng, radio, tipo}]).
const LUGARES = [
  { nombre: 'Taller Santa Cecilia', lat: -33.556244, lng: -70.576561, radio: 200, tipo: 'taller' },
  { nombre: 'Terminal San Carlos', lat: -33.589034870223834, lng: -70.54126717332171, radio: 300, tipo: 'terminal' },
  { nombre: 'Pie Andino', lat: -33.60321443100362, lng: -70.55378241397715, radio: 300, tipo: 'terminal' },
  { nombre: 'Cabezal Juanita', lat: -33.63569611936604, lng: -70.61039566169755, radio: 300, tipo: 'cabezal' },
];
const RADIO_CERCA = 800; // metros: "Cerca de …"

/// Dónde está "parado" el bus (un lugar fijo o el terminal), desde cuándo, y de dónde salió por última vez.
/// Si llega al terminal habiendo salido de un lugar fijo hace poco, ese viaje se suma al promedio.
///   aqui: 'Cabezal Juanita' | 'Terminal' | null;  aquiDesde: Timestamp
///   salioDe: { lugar, fecha }  (se mantiene 3 h o hasta llegar al terminal)
function permanencia(a, lugar, enTerminal, f, Timestamp, viajes) {
  const ahora = f.posTs ?? new Date();
  const aqui = lugar && !lugar.cerca ? lugar.nombre : enTerminal ? 'Terminal' : null;
  const aquiDesde = aqui && a?.aqui === aqui && a?.aquiDesde ? a.aquiDesde : aqui ? Timestamp.fromDate(ahora) : null;
  let salioDe = a?.salioDe ?? null;
  // Acaba de dejar un lugar fijo (no el terminal): anotar la salida.
  if (a?.aqui && a.aqui !== 'Terminal' && a.aqui !== aqui) {
    salioDe = { lugar: a.aqui, fecha: Timestamp.fromDate(ahora) };
  }
  // Acaba de llegar al terminal: si venía de un lugar fijo, medir el viaje.
  if (aqui === 'Terminal' && a?.aqui !== 'Terminal' && salioDe?.fecha?.toDate) {
    const min = (ahora - salioDe.fecha.toDate()) / 60000;
    if (min >= 3 && min <= 180) {
      const v = viajes[salioDe.lugar] ?? { min: 0, n: 0 };
      // Promedio que va olvidando de a poco los viajes viejos.
      const n = Math.min((v.n ?? 0) + 1, 30);
      viajes[salioDe.lugar] = { min: Math.round(((v.min * (n - 1) + min) / n) * 10) / 10, n };
      console.log(`digiCAR: viaje ${salioDe.lugar} → terminal: ${Math.round(min)} min.`);
    }
    salioDe = null;
  }
  const s0 = salioDe?.fecha?.toDate?.();
  if (s0 && ahora - s0 > 3 * 3600 * 1000) salioDe = null;
  return { aqui, aquiDesde, salioDe };
}

/// Lugar fijo donde está el bus ({...lugar, cerca: false}) o cerca del cual va ({..., cerca: true}).
function lugarDe(p, lugares, enCercaniaCH) {
  if (p.lat == null || p.lng == null) return null;
  for (const l of lugares) {
    const m = metros(l, p);
    if (m <= (l.radio ?? 200)) return { ...l, cerca: false, dist: Math.round(m) };
  }
  if (enCercaniaCH) return null; // cerca de Camilo Henríquez manda lo del terminal
  for (const l of lugares) {
    const m = metros(l, p);
    if (m <= RADIO_CERCA) return { ...l, cerca: true, dist: Math.round(m) };
  }
  return null;
}
const MIN_BUSES_TERMINAL = 10; // buses juntos para reconocer dónde está el terminal

/// El terminal es donde hay más buses de la flota juntos. Devuelve su centro, o null
/// si ahora no hay suficientes buses juntos (se sigue usando el centro guardado).
function buscarTerminal(buses) {
  const pts = buses.filter((b) => b.lat != null && b.lng != null);
  let mejor = null;
  for (const p of pts) {
    const cerca = pts.filter((q) => metros(p, q) <= 250);
    if (!mejor || cerca.length > mejor.length) mejor = cerca;
  }
  if (!mejor || mejor.length < MIN_BUSES_TERMINAL) return null;
  return {
    lat: mejor.reduce((s, b) => s + b.lat, 0) / mejor.length,
    lng: mejor.reduce((s, b) => s + b.lng, 0) / mejor.length,
    n: mejor.length,
  };
}

/// Fecha de vencimiento del token (va dentro del mismo token, no hay que preguntarla).
function venceToken(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return p.exp ? new Date(p.exp * 1000) : null;
  } catch {
    return null;
  }
}

const limpiar = (t) => String(t ?? '').trim().replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');

/// Consigue un token de acceso vigente.
/// - DIGICAR_TOKEN: token de sesión directo (dura ~2 h; sirve para probar).
/// - Si no, usa el "refresh token" (dura 7 días y se renueva solo cada vez que se usa):
///   se toma el más nuevo entre el secreto DIGICAR_REFRESH_TOKEN y el guardado en
///   Firestore (privado/digicar, que la app no puede leer), y se guarda el renovado.
async function obtenerToken(db) {
  // 1) Usuario y contraseña (lo normal en el robot): inicia sesión en cada pasada.
  const usuario = (process.env.DIGICAR_USUARIO ?? '').trim();
  const clave = process.env.DIGICAR_CLAVE ?? '';
  if (usuario && clave) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: usuario, password: clave }),
    });
    if (r.status === 401) {
      throw new Error('digiCAR respondió 401 al iniciar sesión: usuario o contraseña de digiCAR incorrectos (¿cambiaron la contraseña?)');
    }
    if (!r.ok) throw new Error(`digiCAR respondió ${r.status} al iniciar sesión: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (!j.token) throw new Error('digiCAR no devolvió token al iniciar sesión');
    return { token: j.token, vence: null, fuente: 'usuario y contraseña' };
  }

  // 2) Token directo o refresh token (respaldo).
  const directo = limpiar(process.env.DIGICAR_TOKEN);
  if (directo) {
    const v = venceToken(directo);
    if (!v || v > new Date()) return { token: directo, vence: v, fuente: 'token directo' };
    console.log('digiCAR: el DIGICAR_TOKEN ya venció, pruebo con el refresh token.');
  }

  const candidatos = [];
  const deSecreto = limpiar(process.env.DIGICAR_REFRESH_TOKEN);
  if (deSecreto) candidatos.push(deSecreto);
  let ref = null;
  if (db) {
    ref = db.doc('privado/digicar');
    const d = await ref.get();
    if (d.exists && d.data().refreshToken) candidatos.push(d.data().refreshToken);
  }
  const vigentes = candidatos
    .map((t) => ({ t, v: venceToken(t) }))
    .filter((x) => !x.v || x.v > new Date())
    .sort((a, b) => (b.v?.getTime() ?? 0) - (a.v?.getTime() ?? 0));
  if (!vigentes.length) {
    if (!candidatos.length) return null;
    throw new Error('digiCAR: el refresh token venció (pasó más de 7 días sin renovarse)');
  }

  const r = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken: vigentes[0].t }),
  });
  if (r.status === 401) throw new Error('digiCAR respondió 401 al renovar: el refresh token venció o lo anularon');
  if (!r.ok) throw new Error(`digiCAR respondió ${r.status} al renovar: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j.token) throw new Error('digiCAR no devolvió token al renovar');
  if (ref && j.refreshToken) {
    const { FieldValue, Timestamp } = await import('firebase-admin/firestore');
    const v = venceToken(j.refreshToken);
    await ref.set({
      refreshToken: j.refreshToken,
      vence: v ? Timestamp.fromDate(v) : null,
      renovado: FieldValue.serverTimestamp(),
    });
  }
  return { token: j.token, vence: venceToken(j.refreshToken ?? ''), fuente: 'refresh token' };
}

/// Todos los buses que el usuario ve en digiCAR, con su nombre y último SoC.
/// Con [ids] pide solo esos equipos (mucho más liviano: 48 en vez de ~658).
async function consultarDigicar(token, ids = null) {
  const filas = [];
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`${BASE}/api/entitiesQuery/find`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        entityFilter: ids
          ? { type: 'entityList', entityType: 'DEVICE', entityList: ids }
          : { type: 'entityType', resolveMultiple: true, entityType: 'DEVICE' },
        pageLink: {
          page,
          pageSize: 500,
          sortOrder: { key: { type: 'ENTITY_FIELD', key: 'name' }, direction: 'ASC' },
        },
        entityFields: [
          { type: 'ENTITY_FIELD', key: 'name' },
          { type: 'ENTITY_FIELD', key: 'label' },
        ],
        latestValues: [
          { type: 'TIME_SERIES', key: 'DigicarSoc' },
          { type: 'TIME_SERIES', key: 'DigicarOdometer' },
          { type: 'TIME_SERIES', key: 'PositionLatitude' },
          { type: 'TIME_SERIES', key: 'PositionLongitude' },
        ],
      }),
    });
    if (r.status === 401) {
      throw Object.assign(new Error('digiCAR respondió 401: el token de digiCAR venció o lo anularon'), { status: 401 });
    }
    if (r.status === 403) {
      throw Object.assign(new Error('digiCAR respondió 403: el token de digiCAR no tiene permiso para ver los buses'), { status: 403 });
    }
    if (!r.ok) {
      throw Object.assign(new Error(`digiCAR respondió ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
    }
    const j = await r.json();
    for (const d of j.data ?? []) {
      const f = d.latest?.ENTITY_FIELD ?? {};
      const t = d.latest?.TIME_SERIES ?? {};
      filas.push({
        id: d.entityId?.id,
        nombre: f.name?.value ?? '',
        etiqueta: f.label?.value ?? '',
        soc: num(t.DigicarSoc?.value),
        socTs: t.DigicarSoc?.ts ? new Date(Number(t.DigicarSoc.ts)) : null,
        odometro: num(t.DigicarOdometer?.value),
        lat: coord(t.PositionLatitude?.value),
        lng: coord(t.PositionLongitude?.value),
        posTs: t.PositionLatitude?.ts ? new Date(Number(t.PositionLatitude.ts)) : null,
      });
    }
    if (!j.hasNext) break;
  }
  return filas;
}

/// Encuentra la PPU del bus: puede venir en el nombre o en la etiqueta del equipo.
function ppuDe(fila, flota) {
  for (const texto of [fila.nombre, fila.etiqueta]) {
    const k = ppuClave(texto);
    if (flota.has(k)) return k;
    // por si el nombre trae algo más, ej. "SPBF-22 (Foton)"
    for (const p of flota) if (k.includes(p)) return p;
  }
  return null;
}

/// Pregunta en la terminal (la contraseña no se ve al escribir/pegar).
export function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) {
      rl._writeToOutput = (s) => {
        if (s.includes(texto)) rl.output.write(texto);
      };
    }
    rl.question(texto, (r) => {
      rl.close();
      if (oculto) process.stdout.write('\n');
      ok(r.trim());
    });
  });
}

/// Para probar en el PC: si no hay credenciales en el ambiente, las pide.
export async function pedirCredencialesSiFaltan() {
  if (process.env.DIGICAR_USUARIO && process.env.DIGICAR_CLAVE) return;
  if (process.env.DIGICAR_TOKEN || process.env.DIGICAR_REFRESH_TOKEN) return;
  if (!process.stdin.isTTY) return;
  process.env.DIGICAR_USUARIO = await preguntar('Usuario (correo) de digiCAR: ');
  process.env.DIGICAR_CLAVE = await preguntar('Contraseña de digiCAR (no se ve): ', true);
}

/// Lugares fijos (los de aquí + los agregados en Firestore: config/lugares).
async function leerLugares(db) {
  let extras = [];
  try {
    extras = (await db.doc('config/lugares').get()).data()?.lista ?? [];
  } catch {}
  return [...LUGARES, ...extras.filter((l) => l?.lat != null && l?.lng != null && l?.nombre)];
}

/// Trazados F10 / F13 (se bajan de red.cl una vez al día).
async function leerRutas(db, FieldValue) {
  try {
    const { cargarRutas } = await import('./rutas_red.mjs');
    return await cargarRutas(db, FieldValue);
  } catch (e) {
    console.warn('Rutas Red:', e.message);
    return null;
  }
}

/// Calcula el estado de cada bus comparando con la pasada anterior ([anterior] = lo último guardado
/// o, en el loop, la lectura anterior en memoria). Devuelve { buses, terminal, viajes }.
async function calcularBuses(mios, anterior, lugares, rutas, Timestamp) {
  // Centro del terminal: se recalcula cuando hay hartos buses juntos; si no, se usa el guardado.
  let terminal = buscarTerminal(mios);
  if (!terminal) terminal = anterior.terminal ?? null;
  const buses = {};
  // Tiempos de viaje aprendidos de cada lugar al terminal: { 'Cabezal Juanita': { min, n } }.
  const viajes = structuredClone(anterior.viajes ?? {});
  const { ubicarEnRuta } = await import('./rutas_red.mjs');
  for (const f of mios) {
    if (f.soc == null) continue;
    const tienePos = f.lat != null && f.lng != null;
    const dist = terminal && tienePos ? Math.round(metros(terminal, f)) : null;
    const lugar = lugarDe(f, lugares, dist != null && dist <= 800);
    buses[f.ppu] = {
      soc: f.soc,
      fecha: f.socTs ? Timestamp.fromDate(f.socTs) : null,
      odometro: f.odometro,
      lat: f.lat,
      lng: f.lng,
      posFecha: f.posTs ? Timestamp.fromDate(f.posTs) : null,
      dist, // metros al terminal
      // -1 se acerca al terminal, 1 se aleja, 0 igual o sin dato (comparado con la pasada anterior)
      tendencia: (() => {
        const antes = anterior.buses?.[f.ppu]?.dist;
        if (dist == null || antes == null || Math.abs(dist - antes) < 50) return anterior.buses?.[f.ppu]?.tendencia ?? 0;
        return dist < antes ? -1 : 1;
      })(),
      enTerminal: dist == null ? null : dist <= RADIO_TERMINAL,
      // Última salida del terminal: hora y SoC con que se fue (para avisar si salió a ruta con poca carga).
      salida: (() => {
        const a = anterior.buses?.[f.ppu];
        const ahoraDentro = dist == null ? null : dist <= RADIO_TERMINAL;
        if (a?.enTerminal === true && ahoraDentro === false) {
          // El SoC solo sirve si el dato del digiCAR es reciente (el bus pudo haber cargado después).
          const socTs = f.socTs ?? a.fecha?.toDate?.() ?? null;
          const fresco = socTs && Date.now() - socTs < 30 * 60 * 1000;
          return { fecha: Timestamp.fromDate(f.posTs ?? new Date()), soc: fresco ? Math.max(a.soc ?? 0, f.soc ?? 0) || null : null };
        }
        const previa = a?.salida;
        const f0 = previa?.fecha?.toDate?.();
        return f0 && Date.now() - f0 < 6 * 3600 * 1000 ? previa : null;
      })(),
      ...permanencia(anterior.buses?.[f.ppu], lugar, dist == null ? null : dist <= RADIO_TERMINAL, f, Timestamp, viajes),
      // En qué recorrido y sentido va, y cuántos km le faltan (solo en ruta: ni en el terminal ni en un lugar fijo).
      recorrido: (dist != null && dist <= RADIO_TERMINAL) || (lugar && !lugar.cerca)
        ? null
        : ubicarEnRuta(rutas, f, anterior.buses?.[f.ppu], anterior.buses?.[f.ppu]?.recorrido),
      lugar: lugar?.nombre ?? null,
      lugarTipo: lugar?.tipo ?? null,
      lugarCerca: lugar?.cerca ?? false,
      lugarDist: lugar?.dist ?? null,
      // -1 se acerca al lugar, 1 se aleja (comparado con la pasada anterior en el mismo lugar)
      lugarTendencia: (() => {
        const antes = anterior.buses?.[f.ppu];
        if (!lugar || antes?.lugar !== lugar.nombre || antes?.lugarDist == null) return 0;
        if (Math.abs(lugar.dist - antes.lugarDist) < 50) return antes.lugarTendencia ?? 0;
        return lugar.dist < antes.lugarDist ? -1 : 1;
      })(),
    };
  }
  return { buses, terminal, viajes };
}

export async function sincronizarDigicar({ db, dbToken = null, probar = false, flota = null }) {
  const acceso = await obtenerToken(dbToken ?? db);
  if (!acceso) {
    console.log('digiCAR: sin credenciales (DIGICAR_USUARIO y DIGICAR_CLAVE), se omite.');
    return null;
  }
  const { token, fuente } = acceso;
  const vence = fuente === 'token directo' ? acceso.vence : null; // el refresh se renueva solo
  console.log(`digiCAR: usando ${fuente}.`);
  const filas = await consultarDigicar(token);
  const conSoc = filas.filter((f) => f.soc != null);
  console.log(`digiCAR: ${filas.length} buses visibles, ${conSoc.length} con SoC.` +
    (vence ? ` Token vence: ${vence.toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })}` : ''));

  if (probar) {
    console.log('Ejemplos (nombre | etiqueta | SoC | hora):');
    const nuestros = filas.filter((f) => /^SR/.test(ppuClave(f.nombre)) || /^SR/.test(ppuClave(f.etiqueta)));
    for (const f of (nuestros.length ? nuestros : filas).slice(0, 12)) {
      console.log(`  ${f.nombre} | ${f.etiqueta} | ${f.soc ?? '-'}% | ` +
        `${f.socTs?.toLocaleString('es-CL', { timeZone: 'America/Santiago' }) ?? '-'}`);
    }
  }

  // Nuestra flota: las PPU del semáforo (o todas si se está probando sin Firestore).
  let mios = filas;
  if (flota) {
    mios = [];
    for (const f of filas) {
      const ppu = ppuDe(f, flota);
      if (ppu) mios.push({ ...f, ppu });
    }
    console.log(`digiCAR: ${mios.length} de ${flota.size} buses de Camilo Henríquez encontrados.`);
  }
  if (probar) {
    const t = buscarTerminal(flota ? mios : mios.filter((f) => /^SR/.test(ppuClave(f.nombre))));
    console.log(t
      ? `Terminal reconocido: ${t.n} buses juntos en ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)} ` +
        `→ https://www.google.com/maps?q=${t.lat},${t.lng}`
      : 'Terminal: ahora no hay suficientes buses juntos para reconocerlo.');
  }
  if (probar || !db) return { vence, filas: mios };

  const { FieldValue, Timestamp } = await import('firebase-admin/firestore');
  const batch = db.batch();
  // Todos los buses van en UN solo documento (digicar/flota): 1 escritura por pasada.
  const refFlota = db.collection('digicar').doc('flota');
  const anterior = (await refFlota.get()).data() ?? {};
  const lugares = await leerLugares(db);
  const rutas = await leerRutas(db, FieldValue);
  const { buses, terminal, viajes } = await calcularBuses(mios, anterior, lugares, rutas, Timestamp);
  const n = Object.keys(buses).length;
  batch.set(refFlota, { buses, terminal, viajes, actualizado: FieldValue.serverTimestamp() });
  if (terminal) {
    const dentro = Object.values(buses).filter((b) => b.enTerminal).length;
    console.log(`digiCAR: ${dentro} buses en el terminal y ${n - dentro} fuera ` +
      `(centro ${terminal.lat.toFixed(5)}, ${terminal.lng.toFixed(5)}).`);
  } else {
    console.log('digiCAR: todavía no se reconoce dónde está el terminal (faltan buses juntos).');
  }
  batch.set(db.doc('config/digicar'), {
    ultimaSync: FieldValue.serverTimestamp(),
    buses: mios.length,
    tokenVence: vence ? Timestamp.fromDate(vence) : null,
  }, { merge: true });
  await batch.commit();
  console.log(`digiCAR: SoC de ${n} buses guardado en Firestore.`);

  if (vence && vence - Date.now() > 86400000) {
    const dias = Math.floor((vence - Date.now()) / 86400000);
    if (dias <= AVISAR_VENCE_DIAS) {
      const e = new Error(`El token de digiCAR vence en ${dias} días ` +
        `(${vence.toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })}).`);
      e.soloAviso = true;
      throw e;
    }
  }
  return { vence, filas: mios };
}

// ---------------------------------------------------------------- En vivo (loop)
// Lee digiCAR cada 60 s (cada bus manda dato nuevo ~1 vez por minuto) durante ~55 min o hasta que
// termine la ventana de turno, y decide cuándo escribir digicar/flota (cada escritura = 1 lectura
// por celular con la app abierta):
//   - al tiro (máx. 1 por minuto) si un bus entra/sale del terminal, llega/sale de un lugar fijo
//     o cambia de recorrido/sentido;
//   - si solo cambian SoC, posición o km que faltan: cada 3 min;
//   - control cada 5 min aunque no cambie nada.
// config/digicar (barra de datos de la app) se escribe cada 5 min.

const DC_IMPORTANTE_MS = 60 * 1000;
const DC_MENOR_MS = 3 * 60 * 1000;
const DC_CONTROL_MS = 5 * 60 * 1000;
const DC_CONFIG_MS = 5 * 60 * 1000;
const DC_MAX_FALLOS_LOGIN = 3;
const DC_MAX_FALLOS_LECTURA = 10;

function hmChile(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 100 + Number(p.minute);
}

/// Horario de turno (igual que el workflow): 08:15–18:15 y 21:45–07:45, hora de Chile.
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

const horaChile = (d = new Date()) => d.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false });
const ms = (t) => (t?.toMillis ? t.toMillis() : null);

/// Lo importante de cada bus: terminal, lugar fijo, salidas y recorrido.
function firmaImportante(buses) {
  const r = {};
  for (const [ppu, b] of Object.entries(buses ?? {})) {
    r[ppu] = [b.enTerminal, b.aqui, b.lugar, b.lugarCerca, ms(b.salida?.fecha), b.salioDe?.lugar,
      b.recorrido?.ruta, b.recorrido?.sentido].join('|');
  }
  return r;
}
/// Lo menor: SoC, posición (~100 m) y km que faltan.
const firmaMenor = (buses) => JSON.stringify(Object.entries(buses ?? {}).map(([ppu, b]) => [ppu, b.soc,
  b.lat == null ? null : Math.round(b.lat * 1000), b.lng == null ? null : Math.round(b.lng * 1000), b.recorrido?.faltaKm]));

/// "SRPK10 salió del terminal, SRRY13 llegó a Cabezal Juanita" (respecto a lo último escrito).
function describirCambios(antes, ahora, buses) {
  const l = [];
  for (const [ppu, f] of Object.entries(ahora)) {
    if (antes[ppu] === f) continue;
    const [t0, aqui0] = (antes[ppu] ?? '').split('|');
    const [t1, aqui1] = f.split('|');
    if (t0 !== t1 && t1 === 'true') l.push(`${ppu} llegó al terminal`);
    else if (t0 !== t1 && t1 === 'false') l.push(`${ppu} salió del terminal`);
    else if (aqui0 !== aqui1 && aqui1) l.push(`${ppu} en ${aqui1}`);
    else if (aqui0 !== aqui1 && aqui0) l.push(`${ppu} salió de ${aqui0}`);
    else if (buses[ppu]?.recorrido) l.push(`${ppu} ${buses[ppu].recorrido.ruta} ${buses[ppu].recorrido.sentido}`);
    else l.push(`${ppu} cambió`);
  }
  return l.length > 6 ? [...l.slice(0, 6), `y ${l.length - 6} más`] : l;
}

/// Las PPU del semáforo (guardadas un día en privado/flota para no leer los 48 buses cada vez).
async function leerFlota(db) {
  const ref = db.doc('privado/flota');
  const g = await ref.get();
  const edad = Date.now() - (g.data()?.fecha?.toMillis?.() ?? 0);
  if (g.exists && Array.isArray(g.data().ppus) && edad < 24 * 3600 * 1000) return new Set(g.data().ppus);
  const s = await db.collection('semaforoch').get();
  const flota = new Set(s.docs.map((d) => ppuClave(d.data().ppu ?? d.id)));
  const { Timestamp } = await import('firebase-admin/firestore');
  await ref.set({ ppus: [...flota], fecha: Timestamp.now() });
  return flota;
}

/**
 * digiCAR en vivo: lee cada [cada] s y escribe solo cuando hace falta (ver arriba).
 * @param escala solo para pruebas: acelera todos los tiempos.
 */
export async function correrDigicarEnVivo({
  db, flota = null, cada = 60, minutos = 55, respetarHorario = true, escala = 1,
} = {}) {
  const T = {
    cada: cada * 1000 * escala, imp: DC_IMPORTANTE_MS * escala, menor: DC_MENOR_MS * escala,
    control: DC_CONTROL_MS * escala, config: DC_CONFIG_MS * escala, min: 60000 * escala,
  };
  const inicio = Date.now();
  let finMs = inicio + minutos * T.min;
  if (respetarHorario) finMs = Math.min(finMs, inicio + minutosHastaFinVentana() * T.min);

  const { FieldValue, Timestamp } = await import('firebase-admin/firestore');
  flota ??= await leerFlota(db);
  const refFlota = db.collection('digicar').doc('flota');
  // Lo último guardado (una lectura por corrida); después la pasada anterior queda en memoria.
  const guardado = (await refFlota.get()).data() ?? {};
  let anterior = guardado;
  const lugares = await leerLugares(db);
  const rutas = await leerRutas(db, FieldValue);

  let firmaImpEscrita = firmaImportante(guardado.buses);
  let firmaMenEscrita = firmaMenor(guardado.buses);
  let ultimaEscritura = ms(guardado.actualizado) ?? 0;
  let ultimaConfig = 0;
  let escrituras = 0;

  let token = null;
  let ids = null; // ids de nuestros buses en digiCAR, si se puede pedir solo esos
  let probadoLista = false;
  let fallosLogin = 0;
  let fallosLectura = 0;
  let n = 0;

  while (true) {
    const t0 = Date.now();
    n++;
    try {
      if (!token) {
        try {
          const acceso = await obtenerToken(db);
          if (!acceso) throw new Error('digiCAR: sin credenciales (DIGICAR_USUARIO y DIGICAR_CLAVE)');
          token = acceso.token; // dura ~2 h: se reusa entre lecturas
          fallosLogin = 0;
        } catch (e) {
          fallosLogin++;
          e.login = true;
          throw e;
        }
      }
      let filas;
      const t1 = Date.now();
      try {
        filas = await consultarDigicar(token, ids);
      } catch (e) {
        if (e.status === 401) {
          token = null;
          e.vencido = true;
        } else if (ids && e.status) {
          // digiCAR respondió con error: puede que no acepte la lista. Una falla de red no cuenta.
          console.log(`[${horaChile()}] digiCAR: falló la consulta solo de nuestros buses (${e.status}); vuelvo a la completa.`);
          ids = null;
        }
        throw e;
      }
      const demora = Date.now() - t1;
      fallosLectura = 0;
      const mios = [];
      for (const f of filas) {
        const ppu = ppuDe(f, flota);
        if (ppu) mios.push({ ...f, ppu });
      }
      // Primera lectura: ¿se puede pedir solo nuestros buses? (mucho más liviano para digiCAR)
      if (!probadoLista) {
        probadoLista = true;
        const lista = mios.map((f) => f.id).filter(Boolean);
        try {
          const r = await consultarDigicar(token, lista);
          if (r.length === lista.length) {
            ids = lista;
            console.log(`digiCAR: se piden solo nuestros ${lista.length} buses (en vez de ${filas.length}).`);
          } else {
            console.log(`digiCAR: pedir solo los nuestros trajo ${r.length} de ${lista.length}; sigo con la consulta completa.`);
          }
        } catch (e) {
          console.log(`digiCAR: no se puede pedir solo los nuestros (${e.message}); sigo con la consulta completa.`);
        }
      }

      const { buses, terminal, viajes } = await calcularBuses(mios, anterior, lugares, rutas, Timestamp);
      anterior = { buses, terminal, viajes };
      const ahoraMs = Date.now();
      const fImp = firmaImportante(buses);
      const fMen = firmaMenor(buses);
      const cambioImp = JSON.stringify(fImp) !== JSON.stringify(firmaImpEscrita);
      const cambioMen = fMen !== firmaMenEscrita;
      const desde = ahoraMs - ultimaEscritura;
      let motivo = null;
      let espera = '';
      if (cambioImp && desde >= T.imp) motivo = describirCambios(firmaImpEscrita, fImp, buses).join(', ');
      else if (cambioImp) espera = 'cambio importante, espera 1 min desde la última';
      else if (cambioMen && desde >= T.menor) motivo = 'SoC / posición';
      else if (desde >= T.control) motivo = 'control (sin cambios)';
      else espera = cambioMen ? `SoC/posición cambió, espera ${Math.ceil((T.menor - desde) / 1000 / escala)} s` : 'sin cambios';

      const dentro = Object.values(buses).filter((b) => b.enTerminal).length;
      const resumen = `${mios.length} buses, ${dentro} en terminal · consulta ${demora} ms`;
      if (motivo) {
        await refFlota.set({ buses, terminal, viajes, actualizado: FieldValue.serverTimestamp() });
        escrituras++;
        ultimaEscritura = ahoraMs;
        firmaImpEscrita = fImp;
        firmaMenEscrita = fMen;
        console.log(`[${horaChile()}] ${resumen} · ESCRIBIÓ #${escrituras} (${motivo})`);
      } else {
        console.log(`[${horaChile()}] ${resumen} · no escribe (${espera})`);
      }
      if (ahoraMs - ultimaConfig >= T.config) {
        await db.doc('config/digicar').set({
          ultimaSync: FieldValue.serverTimestamp(), buses: mios.length, tokenVence: null,
        }, { merge: true });
        ultimaConfig = ahoraMs;
      }
    } catch (e) {
      let fatal;
      if (e.login) {
        console.warn(`[${horaChile()}] digiCAR: falló el inicio de sesión (${fallosLogin}/${DC_MAX_FALLOS_LOGIN}):`, e.message);
        fatal = fallosLogin >= DC_MAX_FALLOS_LOGIN;
      } else {
        fallosLectura++;
        console.warn(`[${horaChile()}] digiCAR: ${e.vencido ? 'el token venció' : 'falló la lectura'} ` +
          `(${fallosLectura}/${DC_MAX_FALLOS_LECTURA}):`, e.message);
        fatal = fallosLectura >= DC_MAX_FALLOS_LECTURA;
      }
      if (fatal) throw e;
      if (e.vencido && fallosLectura === 1) continue; // vuelve a entrar al tiro
    }
    if (Date.now() + T.cada > finMs) break;
    await new Promise((r) => setTimeout(r, Math.max(0, T.cada - (Date.now() - t0))));
  }
  const dur = Math.round((Date.now() - inicio) / T.min);
  console.log(`digiCAR: fin de la corrida · ${n} lecturas en ${dur} min · ${escrituras} escrituras.`);
}

async function anotarErrorDigicar(db, e) {
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).replace(/-/g, '');
  const mensaje = String(e?.message ?? e).slice(0, 1500);
  let h = 0x811c9dc5;
  for (const c of mensaje.split('\n')[0]) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  await db.collection('errores').doc(`${dia}_robot_${h.toString(16)}`).set({
    origen: 'robot digiCAR', donde: 'GitHub Actions · sgdc-robot', mensaje,
    stack: String(e?.stack ?? '').slice(0, 4000), plataforma: 'GitHub',
    ultima: FieldValue.serverTimestamp(), ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'), veces: FieldValue.increment(1), resuelto: false,
  }, { merge: true }).catch(() => {});
}

// ---------------------------------------------------------------- Uso directo
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const conValor = new Set(['--cada', '--minutos']);
  const llave = args.find((a, i) => !a.startsWith('--') && !conValor.has(args[i - 1]));
  const valor = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? Number(args[i + 1]) : NaN;
  };
  // --loop: digiCAR en vivo (workflow digicar.yml). Necesita Firestore (no se usa con --probar).
  if (args.includes('--loop')) {
    (async () => {
      const siempre = args.includes('--siempre');
      if (!siempre && !enHorario()) {
        console.log(`digiCAR: fuera de horario (${horaChile()}): no se lee nada.`);
        return;
      }
      await pedirCredencialesSiFaltan();
      const admin = (await import('firebase-admin')).default;
      const cred = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : JSON.parse(readFileSync(llave ?? 'serviceAccount.json', 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      const db = admin.firestore();
      try {
        await correrDigicarEnVivo({
          db,
          cada: Math.max(20, valor('--cada') || 60),
          minutos: Math.max(1, Math.min(58, valor('--minutos') || 55)),
          respetarHorario: !siempre,
        });
      } catch (e) {
        console.error('Falló digiCAR:', e.message);
        await anotarErrorDigicar(db, e);
        process.exit(1);
      }
    })();
  } else (async () => {
    let db = null;
    let admin = null;
    let flota = null;
    if (!probar || llave) {
      admin = (await import('firebase-admin')).default;
      const cred = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : JSON.parse(readFileSync(llave ?? 'serviceAccount.json', 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      db = admin.firestore();
      const s = await db.collection('semaforoch').get();
      flota = new Set(s.docs.map((d) => ppuClave(d.data().ppu ?? d.id)));
    }
    await sincronizarDigicar({ db: probar ? null : db, dbToken: db, probar, flota });
  })().catch((e) => {
    console.error('Falló digiCAR:', e.message);
    process.exit(1);
  });
}
