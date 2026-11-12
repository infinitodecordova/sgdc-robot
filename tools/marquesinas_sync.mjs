// Trae en vivo el estado de las pistolas de Camilo Henríquez (página de marquesinas de STP)
// y lo deja en Firestore (marquesinas/estado): qué bus está en cada pistola, si está
// cargando o ya terminó, % de carga, kWh y tiempo.
//
// Usuario y clave NUNCA van en un archivo: variables MARQ_USUARIO y MARQ_CLAVE (secretos en GitHub).
// Probar en el PC (no sube nada; si faltan, pide usuario y clave):
//   node marquesinas_sync.mjs --probar
// Ver los datos crudos de algunas pistolas (para ajustar estados que no calzan con la página):
//   node marquesinas_sync.mjs --probar --crudo A5-L,A6-L,B11-R

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const BASE = 'http://186.67.130.114:8091/api/v2';
const TERMINAL = 6; // Camilo Henríquez

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

export async function sincronizarMarquesinas({ db = null, probar = false, crudo = [] } = {}) {
  const usuario = process.env.MARQ_USUARIO ?? '';
  const clave = process.env.MARQ_CLAVE ?? '';
  if (!usuario || !clave) {
    console.log('Marquesinas: sin usuario/clave (MARQ_USUARIO y MARQ_CLAVE), se omite.');
    return null;
  }
  const token = await entrar(usuario, clave);
  const r = await pedir(`${BASE}/marquesinas/estacion/${TERMINAL}`, {
    headers: { Accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Marquesinas respondió ${r.status} al leer las pistolas`);
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
  const cargando = Object.values(pistolas).filter((p) => p.estado === 'cargando').length;
  console.log(`Marquesinas: ${Object.keys(pistolas).length} pistolas, ${cargando} cargando, ` +
    `${Object.keys(buses).length} con bus conectado.`);
  if (probar || !db) {
    for (const [ppu, b] of Object.entries(buses)) {
      console.log(`  ${ppu} · ${b.pistola} · ${b.estado} (código ${b.codigo}) · ${b.soc ?? '-'}% · ${b.kwh ?? '-'} kWh · ${b.tiempo ?? ''}`);
    }
    return { pistolas, buses };
  }
  const { FieldValue, Timestamp } = await import('firebase-admin/firestore');
  // "desde": cuándo quedó el bus en ese estado y pistola (para avisar si lleva rato reservado sin cargar).
  const ref = db.doc('marquesinas/estado');
  const previo = (await ref.get()).data() ?? {};
  const antes = previo.buses ?? {};
  const ahora = Timestamp.now();
  // Minutos desde la pasada anterior (para medir a qué ritmo sube el %).
  const dt = previo.actualizado?.toMillis ? (ahora.toMillis() - previo.actualizado.toMillis()) / 60000 : null;
  const muestras = []; // [tramo de 5 %, minutos, % subidos]
  for (const [ppu, b] of Object.entries(buses)) {
    const a = antes[ppu];
    const igual = a && a.pistola === b.pistola && a.estado === b.estado;
    b.desde = igual && a.desde ? a.desde : ahora;
    // Ritmo de carga: % por minuto entre esta pasada y la anterior, si siguió cargando en la misma pistola.
    if (igual && b.estado === 'cargando' && dt && dt >= 2 && dt <= 15 && a.soc != null && b.soc != null) {
      const sube = b.soc - a.soc;
      if (sube >= 0 && sube <= 20) {
        b.ritmo = Math.round((sube / dt) * 1000) / 1000;
        b.ritmoSoc = Math.round((a.soc + b.soc) / 2);
        muestras.push([Math.min(95, Math.floor(((a.soc + b.soc) / 2) / 5) * 5), dt, sube]);
      }
    } else if (igual && a.ritmo != null) {
      b.ritmo = a.ritmo;
      b.ritmoSoc = a.ritmoSoc ?? null;
    }
  }
  await ref.set({ pistolas, buses, actualizado: FieldValue.serverTimestamp() });

  // Curva de carga de la flota: minutos y % acumulados por tramo de 5 % (los datos viejos pesan menos).
  if (muestras.length) {
    const refCurva = db.doc('config/curvaCarga');
    const curva = (await refCurva.get()).data()?.tramos ?? {};
    for (const [t, min, pct] of muestras) {
      const c = curva[t] ?? { min: 0, pct: 0, n: 0 };
      curva[t] = {
        min: Math.round((c.min * 0.98 + min) * 100) / 100,
        pct: Math.round((c.pct * 0.98 + pct) * 100) / 100,
        n: (c.n ?? 0) + 1,
      };
    }
    await refCurva.set({ tramos: curva, actualizado: FieldValue.serverTimestamp() });
    console.log(`Marquesinas: curva de carga actualizada con ${muestras.length} mediciones.`);
  }
  console.log('Marquesinas: guardado en Firestore.');
  return { pistolas, buses };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const llave = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--crudo');
  (async () => {
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
      const i = args.indexOf('--crudo');
      const crudo = i >= 0 && args[i + 1] ? args[i + 1].split(',') : [];
      await sincronizarMarquesinas({ db, probar, crudo });
    } catch (e) {
      console.error('Falló marquesinas:', e.message);
      if (db) {
        const { FieldValue } = await import('firebase-admin/firestore');
        const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).replace(/-/g, '');
        await db.collection('errores').doc(`${dia}_robot_marquesinas`).set({
          origen: 'robot marquesinas', donde: 'GitHub Actions · sgdc-robot',
          mensaje: String(e.message).slice(0, 1500), stack: String(e.stack ?? '').slice(0, 4000),
          plataforma: 'GitHub', ultima: FieldValue.serverTimestamp(), ultimoUsuario: 'robot',
          usuarios: FieldValue.arrayUnion('robot'), veces: FieldValue.increment(1), resuelto: false,
        }, { merge: true }).catch(() => {});
      }
      process.exit(1);
    }
  })();
}
