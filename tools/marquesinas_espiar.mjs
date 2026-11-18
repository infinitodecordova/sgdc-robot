// Solo lectura (no escribe en Firestore): mira las pistolas de Camilo Henríquez cada 30 s y anota qué
// campos de la página de marquesinas cambian. Sirve para encontrar cómo se ve en los datos un puesto
// "sincronizando" (titila azul en el cargador y muestra un SoC erróneo unos minutos).
//
//   node tools/marquesinas_espiar.mjs [minutos=20] [archivo=espiar_marquesinas.jsonl]
//
// Pide usuario y clave de marquesinas si no están en MARQ_USUARIO / MARQ_CLAVE.
// En pantalla: los cambios por pistola. En el archivo: cada lectura cruda completa (para revisarla después).

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const BASE = 'http://186.67.130.114:8091/api/v2';
const TERMINAL = 6;
const minutos = Number(process.argv[2] ?? 20);
const archivo = process.argv[3] ?? 'espiar_marquesinas.jsonl';

function preguntar(texto, oculto = false) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); ok(r.trim()); });
  });
}

const usuario = process.env.MARQ_USUARIO || await preguntar('Usuario de marquesinas: ');
const clave = process.env.MARQ_CLAVE || await preguntar('Clave de marquesinas (no se ve): ', true);

async function entrar() {
  const r = await fetch(`${BASE}/usuarios/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({ username: usuario, password: clave }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`no pude entrar (${r.status})`);
  return j.token;
}

/// { 'a.b.c': valor } para comparar campo por campo.
function aplanar(o, pre = '', r = {}) {
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) aplanar(v, pre ? `${pre}.${k}` : k, r);
  } else r[pre] = o;
  return r;
}

const hora = () => new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false });
let token = await entrar();
const antes = {};
const fin = Date.now() + minutos * 60000;
console.log(`Mirando ${minutos} min. Lecturas crudas en ${archivo}. Anota la hora si ves un puesto titilar en azul.`);

while (Date.now() < fin) {
  try {
    let r = await fetch(`${BASE}/marquesinas/estacion/${TERMINAL}`, { headers: { Accept: 'application/json', authorization: `Bearer ${token}` } });
    if (r.status === 401) {
      token = await entrar();
      r = await fetch(`${BASE}/marquesinas/estacion/${TERMINAL}`, { headers: { Accept: 'application/json', authorization: `Bearer ${token}` } });
    }
    const j = await r.json();
    appendFileSync(archivo, JSON.stringify({ t: new Date().toISOString(), j }) + '\n');
    for (const m of j.marquesinas ?? []) {
      for (const c of m.cargadores ?? []) {
        const { pistolas, ...cargador } = c;
        for (const p of pistolas ?? []) {
          const ahora = aplanar({ pistola: p, cargador });
          const a = antes[p.nombre];
          if (!a) {
            console.log(`[${hora()}] ${p.nombre}: soc ${p.soc ?? '-'} · estado ${p.estado} · ${p.connectorStatus ?? ''} · bus ${p.bus?.ppu ?? '-'}`);
          } else {
            const cambios = Object.keys({ ...a, ...ahora })
              .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(ahora[k]))
              .map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(ahora[k])}`);
            if (cambios.length) console.log(`[${hora()}] ${p.nombre} (${p.bus?.ppu ?? '-'})\n    ${cambios.join('\n    ')}`);
          }
          antes[p.nombre] = ahora;
        }
      }
    }
  } catch (e) {
    console.log(`[${hora()}] falló la lectura: ${e.message}`);
  }
  await new Promise((ok) => setTimeout(ok, 30000));
}
console.log('Listo.');
