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
//   - informe de cargas del día de turno de ayer y de hoy cada 5 pasadas (24-11: las cargas aparecen ya en curso,
//     con fin = última lectura del medidor, cada ~5 min, y sf/kwh subiendo hasta que terminan).
// Escribe dhemax/hoy (nadie lo lee: es respaldo) solo si hay cargas nuevas, máximo 1 vez cada 5 min, más un
// control cada 30 min con el vivo. El vivo y el avance de las cargas en curso no cuentan como cambio.
// dhemax/hoy = { actualizado, ok, error, dias, cargas: { tr: {...} }, vivo: { pistola: {...} }, medicion }
// Además un control chico en config/dhemax (lo escucha la app para la tira de robots, sin leer dhemax/hoy):
// { ultimaSync, ok, error, cargando, cargas, medicion: {atraso, intervalo, enCurso, n},
//   vivo: { pistola: { soc, dato (ms), si (% inicial real de la carga en curso) } } (solo las que están cargando) },
// cada 10 min, si cambia ok o, si cambió el % de alguna que carga, máximo 1 vez cada 3 min.
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

const ESCRIBIR_MS = 5 * 60000; // dhemax/hoy: máximo 1 escritura cada 5 min (cargas nuevas)
const GUARDAR_MS = 30 * 60000; // dhemax/hoy: control con el vivo aunque no haya cargas nuevas
const CONTROL_MS = 10 * 60000; // config/dhemax (lo escucha la app)
const VIVO_MS = 3 * 60000; // config/dhemax con el % en vivo: máximo 1 cada 3 min (como el SoC de digiCAR)
const AVISO_MS = 60 * 60000; // aviso en ERRORES máximo 1 por hora
const PAUSA_LOGIN_MS = 60 * 60000;
const INFORME_CADA = 5; // el informe (≈100 kB por día) cada 5 pasadas

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
/// Firma de las cargas para saber si hay nuevas, sin importar el orden en que Dhemax las devuelve. Solo lo que
/// no cambia: las cargas en curso vienen con fin = última lectura (cada ~5 min) y sf/kwh subiendo (visto el 24-11),
/// así que eso no cuenta como cambio; los valores finales quedan en la escritura siguiente.
const firma = (cargas) => Object.fromEntries(Object.keys(cargas).sort()
  .map((k) => { const { p, ini, si, dia } = cargas[k]; return [k, JSON.stringify({ p, ini, si, dia })]; }));
const distintas = (a, b) => new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== b[k])).size;

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
  let escrito = firma(cargas);
  let ultimaEscritura = aMs(previo.actualizado) ?? 0;
  let ultimoAviso = aMs(previo.avisoError) ?? 0;
  let primeraVez = Object.keys(cargas).length === 0; // sin historial: lo que ya está no cuenta como "nuevo"
  let ok = true;
  let error = null;
  let escrituras = 0;
  let ultimoControl = 0;
  let okControl = null;
  let vivoControl = null;
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

    // Escritura: solo si hay cargas nuevas o cambiadas (máx. 1 cada 5 min) o control cada 30 min.
    const ahoraFirma = firma(cargas);
    const cambiadas = distintas(ahoraFirma, escrito);
    const desde = Date.now() - ultimaEscritura;
    const motivo = cambiadas > 0 && desde >= ESCRIBIR_MS ? `${cambiadas} cargas nuevas`
      : desde >= GUARDAR_MS ? 'control' : null;
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
      if (!escribe && cambiadas > 0 && cambiadas < 30) {
        for (const k of Object.keys({ ...ahoraFirma, ...escrito }).filter((k) => ahoraFirma[k] !== escrito[k])) {
          const [x, y] = [JSON.parse(escrito[k] ?? '{}'), JSON.parse(ahoraFirma[k] ?? '{}')];
          const campos = Object.keys({ ...x, ...y }).filter((c) => JSON.stringify(x[c]) !== JSON.stringify(y[c]));
          console.log(`   ~ ${y.p ?? x.p} tr ${k}: ` + campos.map((c) => `${c} ${c === 'ini' || c === 'fin' || c === 'ap' ? hm(x[c]) : x[c]}→${c === 'ini' || c === 'fin' || c === 'ap' ? hm(y[c]) : y[c]}`).join(', '));
        }
      }
      escrito = ahoraFirma;
      ultimaEscritura = Date.now();
      console.log(`   ${escribe ? 'guardado' : '(probar: no guarda)'} dhemax/hoy (${motivo}) · ` +
        `aparecen ${medicion.atrasoMediano ?? '—'} min después de terminar (mediana de ${atrasos.length}) · ` +
        `en curso: ${enCurso} · dato en vivo cada ${medicion.intervaloMediano ?? '—'} s (mediana de ${intervalos.length})`);
    }

    // Control chico para la app: cada 10 min, si cambió ok o (máx. 1 cada 3 min) si cambió el % de las que cargan.
    // % inicial real de la carga en curso de cada pistola (del informe): el patio muestra 95/100 falso al conectar,
    // Dhemax no. Es la última carga de esa pistola con lectura reciente (< 10 min).
    const inicialEnCurso = (p) => {
      let u = null;
      for (const c of Object.values(cargas)) if (c.p === p && (!u || c.ini > u.ini)) u = c;
      return u && u.si != null && u.fin != null && Date.now() - u.fin < 10 * 60000 ? u.si : null;
    };
    const vivoApp = Object.fromEntries(Object.entries(vivo)
      .filter(([, x]) => /charg/i.test(x?.estado ?? '') && x.soc != null && x.soc > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, x]) => [p, { soc: x.soc, dato: x.dato, si: inicialEnCurso(p) }]));
    const firmaVivo = JSON.stringify(Object.entries(vivoApp).map(([p, x]) => [p, x.soc, x.si]));
    const desdeControl = Date.now() - ultimoControl;
    if (desdeControl >= CONTROL_MS || okControl !== ok || (firmaVivo !== vivoControl && desdeControl >= VIVO_MS)) {
      vivoControl = firmaVivo;
      await control({
        ok, error, vivo: vivoApp,
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
