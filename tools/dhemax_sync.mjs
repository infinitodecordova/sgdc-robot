// Dhemax (plataforma de los cargadores) → Firestore (dhemax/hoy): las cargas de cada cargador vistas desde el
// propio cargador (aunque se caiga el SGDC o el patio) y el estado en vivo de cada manguera.
// Cliente de solo lectura en dhemax_api.mjs (lista cerrada de rutas: la cuenta puede mandar comandos OCPP).
//
// Usuario y clave NUNCA van en un archivo: variables DHEMAX_USUARIO y DHEMAX_CLAVE (secretos en GitHub).
// El repo es público y sus logs también: el log muestra pistolas, %, kWh y horas (Dhemax no trae patentes).
//
// Modo loop (workflow dhemax.yml, todo el día): ~55 min por corrida y se encadena.
//   node dhemax_sync.mjs --loop --cada 60
//   - en vivo (lineasTerminal) en cada pasada (cada 60 s);
//   - informe de cargas del día de turno de ayer y de hoy cada 2 pasadas.
// Escribe dhemax/hoy SOLO si cambió algo, máximo 1 vez cada 2 min, más un control cada 10 min.
// dhemax/hoy = { actualizado, ok, error, dias, cargas: { tr: {...} }, vivo: { pistola: {...} }, medicion }
// Además un control chico en config/dhemax (lo escucha la app para la tira de robots, sin leer dhemax/hoy):
// { ultimaSync, ok, error, cargando, cargas, medicion: {atraso, intervalo, enCurso, n} }, cada 10 min o si
// cambia ok.
// Medición (primeros días, para decidir el ritmo): cuántos minutos después de terminar aparece cada carga
// (`ap` = cuándo la vio el robot por primera vez), si aparecen en curso, y cada cuánto cambia el dato en vivo.
// Si falla: sigue intentando en la pasada siguiente; avisa en ERRORES máximo 1 vez por hora (las fallas de red
// no). Si Dhemax rechaza el login, pausa 1 h (pausaHasta) para no bloquear la cuenta.
//
// Probar en el PC (no escribe nada; si faltan, pide usuario y clave):
//   node dhemax_sync.mjs --probar                                   una pasada
//   node dhemax_sync.mjs --probar --loop --cada 60 --minutos 5

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { ErrorDhemax, SesionDhemax, diaChile, esErrorDeRed } from './dhemax_api.mjs';

const ESCRIBIR_MS = 2 * 60000; // máximo 1 escritura cada 2 min
const CONTROL_MS = 10 * 60000; // control aunque no cambie nada
const AVISO_MS = 60 * 60000; // aviso en ERRORES máximo 1 por hora
const PAUSA_LOGIN_MS = 60 * 60000;
const INFORME_CADA = 2; // el informe (≈100 kB por día) cada 2 pasadas

const hm = (d) => (d ? new Date(d).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }) : '—');
const aMs = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : null);
const ayer = (d) => diaChile(new Date(d.getTime() - 86400000));
const mediana = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

async function anotarError(db, e) {
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const dia = diaChile().replace(/-/g, '');
  await db.collection('errores').doc(`${dia}_robot_dhemax`).set({
    origen: 'robot Dhemax', donde: 'GitHub Actions · sgdc-robot',
    mensaje: String(e.message).slice(0, 1500), stack: String(e.stack ?? '').slice(0, 4000),
    plataforma: 'GitHub', ultima: FieldValue.serverTimestamp(), ultimoUsuario: 'robot',
    usuarios: FieldValue.arrayUnion('robot'), veces: FieldValue.increment(1), resuelto: false,
  }, { merge: true }).catch(() => {});
}

/// Carga para Firestore (claves cortas: el documento lleva ~200 por día).
const cargaDoc = (c, ap) => ({
  p: c.pistola ?? `${c.cargador}/${c.manguera}`,
  ini: c.inicio ? c.inicio.getTime() : null,
  fin: c.fin ? c.fin.getTime() : null,
  si: c.socIni, sf: c.socFin, kwh: c.kwh, dia: c.dia,
  ap, // cuándo la vio el robot por primera vez (ms)
});

export async function correrDhemax({ db = null, probar = false, cada = 60, minutos = 55, vueltas = null } = {}) {
  const usuario = process.env.DHEMAX_USUARIO ?? '';
  const clave = process.env.DHEMAX_CLAVE ?? '';
  if (!usuario || !clave) {
    console.log('Dhemax: sin usuario/clave (DHEMAX_USUARIO y DHEMAX_CLAVE), se omite.');
    return;
  }
  const escribe = !probar && !!db;
  const FS = escribe ? await import('firebase-admin/firestore') : null;
  const ref = escribe ? db.doc('dhemax/hoy') : null;
  const finMs = Date.now() + minutos * 60000;

  const previo = escribe ? (await ref.get()).data() ?? {} : {};
  const pausa = aMs(previo.pausaHasta);
  if (pausa && pausa > Date.now()) {
    console.log(`Dhemax: en pausa hasta las ${hm(pausa)} (rechazó el login).`);
    if (vueltas != null) return;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(pausa, finMs) - Date.now())));
    if (Date.now() >= finMs - cada * 1000) return;
  }

  const s = new SesionDhemax(usuario, clave);
  // Estado en memoria (se parte de lo guardado para no perder la medición entre corridas).
  let cargas = { ...(previo.cargas ?? {}) };
  let vivo = { ...(previo.vivo ?? {}) };
  const datosVivo = new Map(); // pistola → hora del último dato visto (ms)
  for (const [p, v] of Object.entries(vivo)) if (v?.dato) datosVivo.set(p, v.dato);
  const intervalos = [...(previo.medicion?.intervalos ?? [])].slice(-200); // segundos entre datos en vivo
  const atrasos = [...(previo.medicion?.atrasos ?? [])].slice(-200); // min entre fin de carga y aparición
  let enCurso = previo.medicion?.enCurso ?? 0;
  let escrito = JSON.stringify({ cargas, vivo: soloEstado(vivo) });
  let ultimaEscritura = aMs(previo.actualizado) ?? 0;
  let ultimoAviso = aMs(previo.avisoError) ?? 0;
  let primeraVez = Object.keys(cargas).length === 0; // sin historial: lo que ya está no cuenta como "nuevo"
  let ok = true;
  let error = null;
  let escrituras = 0;
  let ultimoControl = 0;
  let okControl = null;
  const control = async (datos) => {
    if (!escribe) return;
    await db.doc('config/dhemax').set({ ...datos, ultimaSync: FS.FieldValue.serverTimestamp() });
    ultimoControl = Date.now();
    okControl = datos.ok;
  };
  let n = 0;

  for (;;) {
    const ahora = new Date();
    try {
      // En vivo, en cada pasada.
      const v = await s.enVivo();
      const nuevoVivo = {};
      for (const m of v) {
        if (!m.pistola) continue;
        const dato = m.dato ? m.dato.getTime() : null;
        const antes = datosVivo.get(m.pistola);
        if (dato && antes && dato > antes && /charg/i.test(m.estado ?? '')) intervalos.push(Math.round((dato - antes) / 1000));
        if (dato) datosVivo.set(m.pistola, dato);
        nuevoVivo[m.pistola] = { estado: m.estado, error: m.error, soc: m.soc, kw: m.kw, dato, conectado: m.conectado };
      }
      vivo = nuevoVivo;
      const cargando = Object.entries(vivo).filter(([, x]) => /charg/i.test(x.estado ?? ''));

      // Informe de cargas cada INFORME_CADA pasadas (y siempre en la primera).
      let nuevas = [];
      const inicial = primeraVez; // la primera carga de todas: lo que ya estaba no es "nuevo"
      if (n % INFORME_CADA === 0) {
        const dias = [ayer(ahora), diaChile(ahora)];
        const lista = [...(await s.cargasDelDia(dias[0])), ...(await s.cargasDelDia(dias[1]))];
        const siguen = {};
        for (const c of lista) {
          if (c.tr == null) continue;
          const k = String(c.tr);
          const ap = cargas[k]?.ap ?? ahora.getTime();
          if (!cargas[k]) {
            nuevas.push(c);
            if (!c.fin) enCurso++;
            else if (!primeraVez) atrasos.push(Math.round((ahora - c.fin) / 60000));
          }
          siguen[k] = cargaDoc(c, ap);
        }
        cargas = siguen; // solo las de los dos días pedidos (las más viejas se van solas)
        primeraVez = false;
      }
      ok = true;
      error = null;

      const linea = `${hm(ahora)} · ${Object.keys(cargas).length} cargas · cargando ${cargando.length}` +
        (n % INFORME_CADA === 0 ? ` · ${nuevas.length} ${inicial ? 'ya estaban' : 'nuevas'}` : '');
      console.log(linea);
      for (const c of inicial ? [] : nuevas.slice(0, 20)) {
        console.log(`   + ${c.pistola ?? c.cargador} tr ${c.tr} · ${hm(c.inicio)} → ${c.fin ? hm(c.fin) : 'en curso'} · ` +
          `${c.socIni ?? '—'}→${c.socFin ?? '—'} % · ${c.kwh ?? '—'} kWh` +
          (c.fin && n > 0 ? ` · apareció ${Math.round((ahora - c.fin) / 60000)} min después de terminar` : ''));
      }
      for (const [p, x] of cargando) console.log(`   ⚡ ${p} ${x.soc ?? '—'} % · ${x.kw ?? '—'} kW · dato ${hm(x.dato)}`);
      for (const [p, x] of Object.entries(vivo).filter(([, y]) => y.error)) console.log(`   ⚠️ ${p} alarma ${x.error}`);
    } catch (e) {
      ok = false;
      error = esErrorDeRed(e) ? 'Dhemax no respondió (red)' : String(e.message).slice(0, 300);
      console.log(`${hm(ahora)} · falló: ${error}`);
      const loginRechazado = e instanceof ErrorDhemax && /rechazó el usuario/i.test(e.message);
      if (!esErrorDeRed(e) && Date.now() - ultimoAviso > AVISO_MS) {
        ultimoAviso = Date.now();
        if (escribe) await anotarError(db, e);
      }
      if (loginRechazado && escribe) {
        await ref.set({ ok: false, error, pausaHasta: FS.Timestamp.fromMillis(Date.now() + PAUSA_LOGIN_MS),
          avisoError: FS.Timestamp.fromMillis(ultimoAviso), actualizado: FS.FieldValue.serverTimestamp() }, { merge: true });
        await control({ ok: false, error: `${error} (en pausa 1 h)`, cargando: 0, cargas: Object.keys(cargas).length, medicion: null });
        console.log('Dhemax: rechazó el login; pausa 1 h para no bloquear la cuenta.');
        return;
      }
    }

    // Escritura: solo si cambió algo (máx. 1 cada 2 min) o control cada 10 min.
    const ahoraTxt = JSON.stringify({ cargas, vivo: soloEstado(vivo) });
    const desde = Date.now() - ultimaEscritura;
    const motivo = ahoraTxt !== escrito && desde >= ESCRIBIR_MS ? 'cambió'
      : desde >= CONTROL_MS ? 'control' : null;
    const medicion = {
      atrasos: atrasos.slice(-200),
      intervalos: intervalos.slice(-200),
      enCurso,
      atrasoMediano: mediana(atrasos),
      intervaloMediano: mediana(intervalos),
    };
    if (motivo) {
      if (escribe) {
        await ref.set({
          ok, error, dias: [ayer(ahora), diaChile(ahora)], cargas, vivo, medicion,
          avisoError: ultimoAviso ? FS.Timestamp.fromMillis(ultimoAviso) : null,
          pausaHasta: null, actualizado: FS.FieldValue.serverTimestamp(),
        });
        escrituras++;
      }
      escrito = ahoraTxt;
      ultimaEscritura = Date.now();
      console.log(`   ${escribe ? 'guardado' : '(probar: no guarda)'} dhemax/hoy (${motivo}) · ` +
        `aparecen ${medicion.atrasoMediano ?? '—'} min después de terminar (mediana de ${atrasos.length}) · ` +
        `en curso: ${enCurso} · dato en vivo cada ${medicion.intervaloMediano ?? '—'} s (mediana de ${intervalos.length})`);
    }

    // Control chico para la app: cada 10 min o si cambió ok.
    if (Date.now() - ultimoControl >= CONTROL_MS || okControl !== ok) {
      await control({
        ok, error,
        cargando: Object.values(vivo).filter((x) => /charg/i.test(x?.estado ?? '')).length,
        cargas: Object.keys(cargas).length,
        medicion: { atraso: medicion.atrasoMediano, intervalo: medicion.intervaloMediano, enCurso, n: atrasos.length },
      });
    }

    n++;
    if (vueltas != null && n >= vueltas) break;
    if (Date.now() + cada * 1000 > finMs) break;
    await new Promise((r) => setTimeout(r, cada * 1000));
  }
  console.log(`Dhemax: ${n} pasadas, ${escrituras} escrituras${escribe ? '' : ' (--probar)'}.`);
}

/// Lo que cuenta como "cambio" del vivo: estado y error, y el SoC (no la hora del dato ni los kW).
function soloEstado(vivo) {
  return Object.fromEntries(Object.entries(vivo).map(([p, x]) => [p, [x?.estado, x?.error, x?.soc]]));
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
    if (probar && !(process.env.DHEMAX_USUARIO && process.env.DHEMAX_CLAVE) && process.stdin.isTTY) {
      process.env.DHEMAX_USUARIO = await preguntar('Usuario (correo) de Dhemax: ');
      process.env.DHEMAX_CLAVE = await preguntar('Contraseña de Dhemax (no se ve): ', true);
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
      await correrDhemax({
        db, probar,
        cada: loop ? Math.max(30, Number(valor('--cada')) || 60) : 60,
        minutos: Math.max(1, Math.min(58, Number(valor('--minutos')) || 55)),
        vueltas: loop ? null : 1,
      });
    } catch (e) {
      console.error('Falló Dhemax:', e.message);
      process.exit(1);
    }
  })();
}
