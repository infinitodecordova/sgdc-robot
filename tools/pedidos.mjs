// Pedidos de la app al robot (sin token de GitHub en la app): la app deja { fecha, por } en
// robot/pedido, robot/pedidoSgdc o robot/pedidoTurno y el vigilante SGDC lanza el workflow.

export const EDAD_MAXIMA_MS = 10 * 60000; // cubre el hueco entre corridas encadenadas del vigilante

/// Qué workflow(s) lanza cada pedido (igual que hacía la app).
export const PEDIDOS = {
  pedido: [['digicar.yml', null]],
  pedidoSgdc: [['sgdc.yml', null]],
  pedidoTurno: [['marquesinas.yml', { turno: 'true' }], ['digicar.yml', { turno: 'true' }]],
};

const ms = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : null);

/// ¿Hay que atender este pedido? Sí si su fecha es más nueva que la última atendida y tiene ≤ 10 min.
export function debeAtender(fecha, ultimoAtendido, ahora = Date.now()) {
  const f = ms(fecha);
  if (f == null) return false;
  if (ultimoAtendido != null && f <= ultimoAtendido) return false;
  return ahora - f <= EDAD_MAXIMA_MS;
}

/// Escucha los 3 documentos (1 lectura por cambio). [lanzar](doc, fecha) atiende cada pedido nuevo.
/// Devuelve una función para cerrar los listeners.
export function escucharPedidos(db, lanzar, { ahora = () => Date.now(), alError = () => {} } = {}) {
  const ultimos = {};
  const cierres = Object.keys(PEDIDOS).map((nombre) =>
    db.doc(`robot/${nombre}`).onSnapshot(
      (snap) => {
        const fecha = ms(snap.data()?.fecha);
        if (!debeAtender(fecha, ultimos[nombre], ahora())) return;
        ultimos[nombre] = fecha;
        lanzar(nombre, fecha);
      },
      (e) => alError(e, nombre),
    ),
  );
  return () => cierres.forEach((c) => c());
}
