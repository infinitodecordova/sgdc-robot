// Pausa de 1 h cuando una página rechaza el usuario/clave del robot (marquesinas y digiCAR; Dhemax y el planillón
// tienen la suya). Sin esto, tras 3 rechazos la corrida termina y el respaldo del vigilante la relanza cada 4 min
// (~45 logins fallidos por hora, riesgo de bloquear la cuenta).
// La pausa se guarda en `privado/pausa_<robot>` (doc que la app no lee ni escucha). Mientras dura, el robot
// ESPERA dentro de la corrida (como el planillón): si saliera al tiro, el encadenado lanzaría otra al instante, y
// una corrida "en curso" tampoco la relanza el respaldo del vigilante.

export const PAUSA_LOGIN_MS = 60 * 60 * 1000;
export const MAX_RECHAZOS_LOGIN = 3;

const aMs = (t) => (t == null ? null : t.toMillis ? t.toMillis() : t.toDate ? t.toDate().getTime() : Number(t) || null);

/// ¿La respuesta de login es un rechazo de credenciales (y no una falla de red, timeout o 5xx)?
export const esRechazoLogin = (status) => status === 400 || status === 401 || status === 403;

/// Hora (ms) hasta la que hay pausa, o null si no hay (o ya pasó).
export async function leerPausa(db, robot, ahora = Date.now()) {
  if (!db) return null;
  const p = aMs((await db.doc(`privado/pausa_${robot}`).get()).data()?.pausaHasta);
  return p && p > ahora ? p : null;
}

/// Deja la pausa de 1 h.
export async function guardarPausa(db, robot, FS, ahora = Date.now()) {
  if (!db) return;
  await db.doc(`privado/pausa_${robot}`).set({
    pausaHasta: FS.Timestamp.fromMillis(ahora + PAUSA_LOGIN_MS),
    motivo: 'el login fue rechazado varias veces seguidas',
    fecha: FS.FieldValue.serverTimestamp(),
  });
}

/// Si hay pausa vigente, espera (como máximo hasta [finMs]) y devuelve true si la corrida debe terminar sin
/// intentar login (la pausa no terminó antes del fin de la corrida). Con esperar=false no espera: devuelve true.
export async function respetarPausa(db, robot, finMs, { log = console.log, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), ahora = Date.now, esperar = true } = {}) {
  const pausa = await leerPausa(db, robot, ahora());
  if (!pausa) return false;
  log(`${robot}: en pausa hasta las ${new Date(pausa).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' })} (rechazaron el login varias veces); no se intenta.`);
  if (!esperar) return true; // pedido suelto (sin loop): no se queda esperando
  await dormir(Math.max(0, Math.min(pausa, finMs) - ahora()));
  if (ahora() < pausa) {
    log(`${robot}: terminó la corrida en pausa, sin intentar el login.`);
    return true;
  }
  return false;
}
