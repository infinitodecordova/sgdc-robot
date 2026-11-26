// Respaldo cruzado de los robots: preguntar a GitHub si un workflow está corriendo y lanzarlo si no.
// Lo usan el vigilante SGDC (sgdc_sync.mjs) y Dhemax (dhemax_sync.mjs). No toca Firestore.
// Necesita GH_TOKEN y GITHUB_REPOSITORY; sin ellos no hace nada.
import { recorteSeguro } from './log_seguro.mjs';

/// Estados de una corrida que cuentan como "andando o en cola" (todo menos completed).
const ESTADOS_ACTIVOS = ['in_progress', 'queued', 'waiting', 'requested', 'pending'];

export function hayCredenciales() {
  return Boolean(process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY);
}

export async function github(ruta, opciones = {}) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${ruta}`, {
    ...opciones,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status} en ${ruta}`);
  return r.status === 204 ? null : r.json();
}

/// ¿Alguna de las corridas está andando o en cola? (cualquier estado distinto de completed)
export function hayCorridaActiva(corridas) {
  return (corridas ?? []).some((c) => c.status !== 'completed' || ESTADOS_ACTIVOS.includes(c.status));
}

/// ¿Hay una corrida de este workflow andando o en cola?
export async function corridaActiva(wf) {
  const { workflow_runs: corridas = [] } = await github(`/actions/workflows/${wf}/runs?per_page=30`);
  return hayCorridaActiva(corridas);
}

/// Lanza un workflow en main, con inputs opcionales.
export async function lanzarWorkflow(wf, inputs = null) {
  await github(`/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    body: JSON.stringify(inputs ? { ref: 'main', inputs } : { ref: 'main' }),
  });
}

/// Decisión pura: ¿lanzar ahora? Sin corridas activas y pasada la espera desde el último lanzamiento
/// (GitHub tarda en mostrar la corrida recién lanzada).
export function debeLanzar({ corridas, ultimoLanzamiento = null, ahora = Date.now(), esperaMin = 10 }) {
  if (hayCorridaActiva(corridas)) return false;
  if (ultimoLanzamiento != null && ahora - ultimoLanzamiento < esperaMin * 60000) return false;
  return true;
}

/// Respaldo de un workflow: si no corre y no lo lancé hace poco, lo lanza. Nunca lanza excepciones.
/// Devuelve true si lo lanzó. `estado` guarda el último lanzamiento ({ ultimo }) y la última revisión ({ reviso }).
export async function respaldarWorkflow(wf, inputs, estado, { cadaMin = 5, ahora = Date.now() } = {}) {
  if (!hayCredenciales()) return false;
  if (estado.reviso != null && ahora - estado.reviso < cadaMin * 60000) return false;
  estado.reviso = ahora;
  try {
    const { workflow_runs: corridas = [] } = await github(`/actions/workflows/${wf}/runs?per_page=30`);
    if (!debeLanzar({ corridas, ultimoLanzamiento: estado.ultimo ?? null, ahora })) return false;
    await lanzarWorkflow(wf, inputs);
    estado.ultimo = ahora;
    return true;
  } catch (e) {
    console.warn(`Respaldo de ${wf}: no se pudo revisar (${recorteSeguro(e.message)})`);
    return false;
  }
}
