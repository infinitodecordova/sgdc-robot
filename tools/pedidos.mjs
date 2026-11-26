// Pedidos de la app al robot (sin token de GitHub en la app): la app deja { fecha, por } en
// robot/pedido, robot/pedidoSgdc o robot/pedidoTurno y el vigilante SGDC lanza el workflow.

export const EDAD_MAXIMA_MS = 10 * 60000; // cubre el hueco entre corridas encadenadas del vigilante
// "Iniciar turno" vale más tiempo: si el vigilante tarda en volver (cron saltado) no se debe perder el inicio del turno.
export const EDAD_MAXIMA_TURNO_MS = 30 * 60000;
export const ENTRE_LANZAMIENTOS_MS = 2 * 60000; // el mismo pedido no se lanza dos veces en menos de esto

/// Qué workflow(s) lanza cada pedido (igual que hacía la app).
export const PEDIDOS = {
  pedido: [['digicar.yml', null]],
  pedidoSgdc: [['sgdc.yml', null]],
  pedidoTurno: [['marquesinas.yml', { turno: 'true' }], ['digicar.yml', { turno: 'true' }]],
};

const ms = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : null);

/// Edad máxima de un pedido: 30 min el de Iniciar turno, 10 min los demás.
export const edadMaxima = (nombre) => (nombre === 'pedidoTurno' ? EDAD_MAXIMA_TURNO_MS : EDAD_MAXIMA_MS);

/// ¿Hay que atender este pedido? Sí si su fecha es más nueva que la última atendida y no es más vieja que [edadMax].
export function debeAtender(fecha, ultimoAtendido, ahora = Date.now(), edadMax = EDAD_MAXIMA_MS) {
  const f = ms(fecha);
  if (f == null) return false;
  if (ultimoAtendido != null && f <= ultimoAtendido) return false;
  return ahora - f <= edadMax;
}

/// ¿Pasó el mínimo entre dos lanzamientos del mismo pedido? (null = nunca se lanzó)
export const pasoElMinimo = (ultimoLanzamiento, ahora = Date.now()) =>
  ultimoLanzamiento == null || ahora - ultimoLanzamiento >= ENTRE_LANZAMIENTOS_MS;

/// Fechas (ms) ya atendidas que quedaron guardadas en privado/pedidos por un vigilante anterior.
export function atendidosGuardados(datos) {
  const a = datos?.atendido ?? {};
  return Object.fromEntries(Object.keys(PEDIDOS).map((n) => [n, ms(a[n])]).filter(([, v]) => v != null));
}

/// Escucha los 3 documentos (1 lectura por cambio). [lanzar](doc, fecha) atiende cada pedido nuevo.
/// Antes de escuchar lee una vez privado/pedidos (lo ya atendido por el vigilante anterior, para no repetir un
/// pedido de hace minutos) y después de lanzar lo deja anotado ahí. Devuelve una función para cerrar los listeners.
export async function escucharPedidos(db, lanzar, { ahora = () => Date.now(), alError = () => {} } = {}) {
  const ref = db.doc('privado/pedidos');
  let ultimos = {};
  try {
    ultimos = atendidosGuardados((await ref.get()).data());
  } catch (e) {
    alError(e, 'privado/pedidos');
  }
  const lanzado = {}; // nombre → hora del último lanzamiento (en esta corrida)
  const cierres = Object.keys(PEDIDOS).map((nombre) =>
    db.doc(`robot/${nombre}`).onSnapshot(
      (snap) => {
        const fecha = ms(snap.data()?.fecha);
        if (!debeAtender(fecha, ultimos[nombre], ahora(), edadMaxima(nombre))) return;
        ultimos[nombre] = fecha;
        ref.set({ atendido: { [nombre]: fecha } }, { merge: true }).catch((e) => alError(e, 'privado/pedidos'));
        if (!pasoElMinimo(lanzado[nombre], ahora())) return; // ya se lanzó hace menos de 2 min: ese lanzamiento lo cubre
        lanzado[nombre] = ahora();
        lanzar(nombre, fecha);
      },
      (e) => alError(e, nombre),
    ),
  );
  return () => cierres.forEach((c) => c());
}
