// SOLO LECTURA (no escribe en Firestore ni cambia nada en el ICR): entra al planillón de despacho,
// lista los bloques del día y muestra las salidas con PPU del bloque actual y el siguiente de los
// servicios de los dos sentidos (R: sale del terminal; I: viene del cabezal, sin conductor).
// Si está tools/serviceAccount.json, marca con ★ los buses del semáforo (solo lee semaforoch).
// Lo corre el usuario en su PC.
//
//   ICR_USUARIO=... ICR_CLAVE=... node tools/planillon_espiar.mjs            una mirada
//   node tools/planillon_espiar.mjs --expira 40                             además, deja la sesión
//                                                                           quieta y cada 5 min revisa
//                                                                           si sigue viva (hasta 40 min)
// Si faltan ICR_USUARIO / ICR_CLAVE, los pregunta (la clave no se ve).
// Muestra solo hora, despacho, real, PPU y nombre corto. Nunca el RUT. No muestra la respuesta del login.

import { existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';
import {
  CAMPO_SERVICIOS, SERVICIOS_I, SERVICIOS_R, SesionIcr, bloqueDeAhora, esErrorDeRed, fechaIcr, minutoChile, sentidoDe,
} from './planillon_icr.mjs';

/// Los 48 PPU del semáforo, si está serviceAccount.json en esta carpeta (solo lectura). Si no, null.
async function flotaSemaforo() {
  const ruta = new URL('./serviceAccount.json', import.meta.url);
  if (!existsSync(ruta)) return null;
  try {
    const admin = (await import('firebase-admin')).default;
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(ruta, 'utf8'))) });
    const s = await admin.firestore().collection('semaforoch').get();
    return new Set(s.docs.map((d) => String(d.data().ppu ?? d.id).toUpperCase().replace(/[^A-Z0-9]/g, '')));
  } catch (e) {
    console.log(`(no pude leer los buses del semáforo: ${e.message})`);
    return null;
  }
}

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

const args = process.argv.slice(2);
const iExp = args.indexOf('--expira');
const minutosExpira = iExp >= 0 ? Math.max(5, Number(args[iExp + 1]) || 40) : 0;

const usuario = process.env.ICR_USUARIO || await preguntar('Usuario del ICR: ');
const clave = process.env.ICR_CLAVE || await preguntar('Clave del ICR (no se ve): ', true);
const hora = () => new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false });

const s = new SesionIcr(usuario, clave);
try {
  await s.entrar();
  console.log(`[${hora()}] Sesión iniciada (cookies: ${[...s.cookies.keys()].join(', ')}).`);

  const fecha = fechaIcr();
  const bloques = await s.bloques(fecha);
  console.log(`Bloques del ${fecha}: ${bloques.length} (${bloques[0]?.nombre ?? '?'} … ${bloques.at(-1)?.nombre ?? '?'})`);
  const b = bloqueDeAhora(bloques, minutoChile());
  if (!b) console.log('Ahora no cae en ningún bloque.');
  else console.log(`Bloque actual según la hora: ${b.actual.nombre} · siguiente: ${b.siguiente?.nombre ?? '—'}`);

  // Servicios de cada sentido, como los pide la página (despacho-planillon.html?id=…).
  const servicios = [];
  for (const [sentido, campo] of Object.entries(CAMPO_SERVICIOS)) {
    try {
      const l = await s.servicios(campo);
      console.log(`Servicios ${sentido} (id=${campo}): ${l.join(', ') || '(ninguno)'}`);
      servicios.push(...l);
    } catch (e) {
      const resp = sentido === 'I' ? SERVICIOS_I : SERVICIOS_R;
      console.log(`Servicios ${sentido} (id=${campo}): falló (${e.message}); uso ${resp.join(', ')}`);
      servicios.push(...resp);
    }
  }
  const flota = await flotaSemaforo();
  console.log(flota ? `Buses del semáforo: ${flota.size} (★ = es nuestro)` : 'Sin serviceAccount.json: no marco cuáles son nuestros.');
  const resumen = {};

  for (const servicio of servicios) {
    const pedidos = [['Actual', 'actual'], ...(b?.actual ? [[b.actual.id, `id ${b.actual.id}`]] : []),
      ...(b?.siguiente ? [[b.siguiente.id, 'siguiente']] : [])];
    for (const [sel, etiqueta] of pedidos) {
      try {
        const r = await s.bloque(servicio, sel, fecha);
        const conPpu = r.salidas.filter((x) => x.ppu);
        const nuestras = flota ? conPpu.filter((x) => flota.has(x.ppu)) : conPpu;
        console.log(`\n${servicio} · ${etiqueta} → ${r.bloque || r.id}: ${r.salidas.length} salidas, ${conPpu.length} con PPU` +
          (flota ? `, ${nuestras.length} nuestras` : ''));
        for (const x of conPpu) {
          const mio = flota?.has(x.ppu) ? '★' : ' ';
          // Sentido I: sin conductor (no se guarda ni se muestra).
          const quien = sentidoDe(servicio) === 'I' ? '' : ` · ${x.conductor ?? '—'}`;
          console.log(` ${mio}${x.hora} · despacho ${x.despacho ?? '—'} · real ${x.real ?? '—'} · ${x.ppu}${quien} · ${x.estado ?? ''}`);
        }
        const r2 = (resumen[sentidoDe(servicio)] ??= new Set()); // Set: "Actual" e "id" repiten las mismas
        for (const x of nuestras) r2.add(`${x.ppu} ${servicio} ${x.despacho ?? x.hora}`);
      } catch (e) {
        console.log(`\n${servicio} · ${etiqueta}: falló (${e.message})`);
      }
    }
  }

  for (const [sentido, l] of Object.entries(resumen)) {
    console.log(`\nSentido ${sentido}: ${l.size} salidas ${flota ? 'de buses nuestros' : 'con PPU'} (actual y siguiente): ${[...l].join(' · ') || '—'}`);
  }

  // Cómo se ve una sesión vencida: el mismo pedido sin cookie y con una cookie inventada.
  console.log('\n--- Cómo responde sin sesión válida ---');
  for (const [nombre, cookies] of [['sin cookie', new Map()], ['cookie inventada', new Map([['ASP.NET_SessionId', 'x'.repeat(24)]])]]) {
    const otra = new SesionIcr('', '');
    otra.cookies = cookies;
    try {
      const r = await otra.bloques(fecha);
      console.log(`${nombre}: respondió igual que con sesión (${r.length} bloques) → la sesión no se revisa en este pedido`);
    } catch (e) {
      console.log(`${nombre}: ${e.message}${e.sesion ? ' (el robot lo toma como sesión vencida y vuelve a entrar)' : ''}`);
    }
    try {
      console.log(`  Valida_Sesion ${nombre}:`, JSON.stringify(await otra.validaSesion()));
    } catch (e) {
      console.log(`  Valida_Sesion ${nombre}: falló (${e.message})`);
    }
  }

  if (minutosExpira) {
    // Cada pedido renueva la sesión, así que no se puede revisar la misma varias veces: se abren
    // varias sesiones ahora y cada una se prueba UNA vez, después de distintos minutos sin uso.
    const pruebas = [10, 20, 30, 45, 60].filter((m) => m <= minutosExpira);
    if (!pruebas.length) pruebas.push(minutosExpira);
    console.log(`\n--- Sesiones quietas: abro ${pruebas.length} y pruebo cada una a los ${pruebas.join(', ')} min ---`);
    const sesiones = [];
    for (const m of pruebas) {
      const x = new SesionIcr(usuario, clave);
      await x.entrar();
      sesiones.push([m, x]);
    }
    const inicio = Date.now();
    for (const [m, x] of sesiones) {
      const espera = inicio + m * 60000 - Date.now();
      if (espera > 0) await new Promise((ok) => setTimeout(ok, espera));
      let datos;
      try {
        datos = `sigue viva (bloques OK: ${(await x.bloques(fecha)).length})`;
      } catch (e) {
        datos = `VENCIDA → ${e.message}`;
      }
      console.log(`[${hora()}] sesión quieta ${m} min: ${datos}`);
    }
  }
  console.log('\nListo (no se escribió nada).');
} catch (e) {
  console.error(`Falló: ${e.message}${esErrorDeRed(e) ? ' (falla de red: ¿el servidor está arriba?)' : ''}`);
  process.exit(1);
}
