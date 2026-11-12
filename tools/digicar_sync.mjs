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
];
const RADIO_CERCA = 800; // metros: "Cerca de …"

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
async function consultarDigicar(token) {
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
        entityFilter: { type: 'entityType', resolveMultiple: true, entityType: 'DEVICE' },
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
    if (r.status === 401) throw new Error('digiCAR respondió 401: el token de digiCAR venció o lo anularon');
    if (r.status === 403) throw new Error('digiCAR respondió 403: el token de digiCAR no tiene permiso para ver los buses');
    if (!r.ok) throw new Error(`digiCAR respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
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
  // Todos los buses van en UN solo documento (digicar/flota): 1 escritura por pasada,
  // aunque corra cada 5 minutos (288 escrituras al día en vez de ~14.000).
  // Centro del terminal: se recalcula cuando hay hartos buses juntos; si no, se usa el guardado.
  const refFlota = db.collection('digicar').doc('flota');
  const anterior = (await refFlota.get()).data() ?? {};
  let terminal = buscarTerminal(mios);
  if (!terminal) terminal = anterior.terminal ?? null;
  let extras = [];
  try {
    extras = (await db.doc('config/lugares').get()).data()?.lista ?? [];
  } catch {}
  const lugares = [...LUGARES, ...extras.filter((l) => l?.lat != null && l?.lng != null && l?.nombre)];
  const buses = {};
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
          return { fecha: Timestamp.fromDate(f.posTs ?? new Date()), soc: a.soc ?? f.soc };
        }
        const previa = a?.salida;
        const f0 = previa?.fecha?.toDate?.();
        return f0 && Date.now() - f0 < 6 * 3600 * 1000 ? previa : null;
      })(),
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
  const n = Object.keys(buses).length;
  batch.set(refFlota, { buses, terminal, actualizado: FieldValue.serverTimestamp() });
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

// ---------------------------------------------------------------- Uso directo
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const llave = args.find((a) => !a.startsWith('--'));
  (async () => {
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
