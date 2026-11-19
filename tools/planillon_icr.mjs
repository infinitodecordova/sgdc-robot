// Cliente de SOLO LECTURA del planillón de despacho ICR (http://200.55.219.100:8090).
// Lo usan planillon_espiar.mjs (en el PC) y planillon_sync.mjs (robot en GitHub).
//
// Cómo funciona la página (visto en el HAR del 19-11 y en login.html):
//   - Login: POST /wsBase.asmx/Acceso_Login con JSON {usuario, password}. La sesión queda en la cookie
//     ASP.NET_SessionId, que se manda en todo lo demás.
//   - Datos: POST multipart a /Server/PlanillonCtr.php con `accion`:
//       planillon_lista_bloques (fecha)                       → bloques del día (id, desde, hasta)
//       planillon_bloque_actual (servicio, bloqueseleccionado, fecha) → salidas del bloque
//
// Solo se llaman esas tres cosas (y Valida_Sesion en el espía). NUNCA acciones que modifiquen, y nunca
// Usuario_Autentificado (devuelve la contraseña). La respuesta del login no se muestra ni se guarda.
// El RUT del conductor (`conductor`) se descarta apenas llega: no sale de este archivo.

export const BASE = 'http://200.55.219.100:8090';
export const SERVICIOS = ['1040-R', '1040-R-FTS', '1043-R', '1043-R-FTS'];

/// Falla de red (servidor caído, sin conexión, tiempo agotado): no va a ERRORES.
export function esErrorDeRed(e) {
  const t = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
  return /AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR|socket hang up|network/i
    .test(t);
}

/// Error de la página (sesión vencida o respuesta rara). `sesion` = probablemente hay que volver a entrar.
export class ErrorIcr extends Error {
  constructor(mensaje, { sesion = false, status = null } = {}) {
    super(mensaje);
    this.sesion = sesion;
    this.status = status;
  }
}

/// "19/11/2026" para la fecha de Chile de [d].
export function fechaIcr(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}

/// "2026-11-19" (como turnos.dia en Firestore).
export function diaChile(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
}

/// Minutos desde medianoche, hora de Chile.
export function minutoChile(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/// "10:04:00" / "9:00:00" → minutos desde medianoche (null si viene vacío).
export function aMinutos(h) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(h ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/// "10:04:00" → "10:04" (null si viene vacío).
export function hhmm(h) {
  const m = aMinutos(h);
  return m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const MINUSCULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
const titulo = (s) => s.toLocaleLowerCase('es-CL').replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase('es-CL'));

/// " NELSON ENRIQUE ROJAS GARRIDO" → "Nelson Rojas" (primer nombre + primer apellido, formato Título).
/// En Chile van nombres y después los dos apellidos: con 3 o más palabras, el primer apellido es la
/// penúltima; con 2, la última. "de", "del", "la"… se pegan al apellido que sigue.
export function nombreCorto(completo) {
  const p = String(completo ?? '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return null;
  // Junta partículas con la palabra siguiente ("DE LA FUENTE" queda como una sola).
  const w = [];
  for (let i = 0; i < p.length; i++) {
    let x = p[i];
    while (MINUSCULAS.has(x.split(' ').at(-1).toLowerCase()) && i + 1 < p.length) x = `${x} ${p[++i]}`;
    w.push(x);
  }
  if (w.length === 1) return titulo(w[0]);
  const apellido = w.length >= 3 ? w[w.length - 2] : w[1];
  return titulo(`${w[0]} ${apellido}`).replace(/\b(De|Del|La|Las|Los|Y)\b/g, (x) => x.toLowerCase());
}

/// Sesión con el ICR: guarda las cookies que manda el servidor y las devuelve en cada pedido.
export class SesionIcr {
  constructor(usuario, clave, { timeoutMs = 20000 } = {}) {
    this.usuario = usuario;
    this.clave = clave;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
    this.dentro = false;
  }

  _guardarCookies(r) {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }

  async _pedir(ruta, opciones = {}) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), this.timeoutMs);
    try {
      const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(`${BASE}${ruta}`, {
        ...opciones,
        redirect: 'manual',
        signal: c.signal,
        headers: { ...(opciones.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
      });
      this._guardarCookies(r);
      return r;
    } finally {
      clearTimeout(t);
    }
  }

  /// Inicia sesión. No muestra ni guarda nada de la respuesta (puede traer datos del usuario).
  async entrar() {
    this.cookies.clear();
    this.dentro = false;
    // Primero la página de login, para que el servidor entregue la cookie de sesión.
    await this._pedir('/login.html').then((r) => r.arrayBuffer()).catch(() => {});
    const r = await this._pedir('/wsBase.asmx/Acceso_Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: JSON.stringify({ usuario: this.usuario, password: this.clave }),
    });
    const texto = await r.text();
    if (!r.ok) throw new ErrorIcr(`el ICR respondió ${r.status} al iniciar sesión`, { status: r.status });
    let d;
    try {
      d = JSON.parse(JSON.parse(texto).d);
    } catch {
      throw new ErrorIcr('el ICR devolvió algo raro al iniciar sesión');
    }
    if (d?.completado !== true) {
      // El mensaje de la página ("usuario o clave incorrectos"…), recortado y sin nada más.
      throw new ErrorIcr(`el ICR no dejó entrar: ${String(d?.mensaje ?? 'sin mensaje').slice(0, 120)}`);
    }
    if (!this.cookies.has('ASP.NET_SessionId')) {
      throw new ErrorIcr('el ICR no entregó la cookie de sesión al iniciar sesión');
    }
    this.dentro = true;
  }

  /// ¿Sigue viva la sesión? (lo mismo que hace la página al abrir el menú). Solo para el espía.
  async validaSesion() {
    const r = await this._pedir('/wsBase.asmx/Valida_Sesion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: '{}',
    });
    const texto = await r.text();
    try {
      return { status: r.status, ...JSON.parse(JSON.parse(texto).d) };
    } catch {
      return { status: r.status, crudo: texto.slice(0, 200) };
    }
  }

  /// POST a PlanillonCtr.php. Lanza ErrorIcr({sesion:true}) si la respuesta parece de sesión vencida
  /// (redirección, 401/403, HTML en vez de JSON o completado:false).
  async _planillon(campos) {
    const f = new FormData();
    for (const [k, v] of Object.entries(campos)) f.append(k, String(v));
    const r = await this._pedir('/Server/PlanillonCtr.php', { method: 'POST', body: f });
    const texto = await r.text();
    if (r.status >= 300 && r.status < 400) throw new ErrorIcr(`el ICR redirigió (${r.status}): sesión vencida`, { sesion: true, status: r.status });
    if (r.status === 401 || r.status === 403) throw new ErrorIcr(`el ICR respondió ${r.status}: sesión vencida`, { sesion: true, status: r.status });
    if (!r.ok) throw new ErrorIcr(`el ICR respondió ${r.status} en ${campos.accion}`, { status: r.status });
    let j;
    try {
      j = JSON.parse(texto.trim());
    } catch {
      throw new ErrorIcr(`el ICR no devolvió JSON en ${campos.accion} (¿sesión vencida?): ${texto.trim().slice(0, 80)}`, { sesion: true });
    }
    if (j?.completado !== true) {
      throw new ErrorIcr(`el ICR respondió completado:false en ${campos.accion}: ${String(j?.mensaje ?? '').slice(0, 120)}`, { sesion: true });
    }
    return j;
  }

  /// Bloques del día: [{ id, desde, hasta }] con minutos desde medianoche, ordenados.
  async bloques(fecha = fechaIcr()) {
    const j = await this._planillon({ accion: 'planillon_lista_bloques', fecha });
    return (j.bloques ?? [])
      .map((b) => ({ id: String(b.id), nombre: String(b.bloque ?? ''), desde: aMinutos(b.desde), hasta: aMinutos(b.hasta) }))
      .filter((b) => b.desde != null && b.hasta != null)
      .sort((a, b) => a.desde - b.desde);
  }

  /// Salidas de un bloque ('Actual' o el id). Devuelve { id, bloque, salidas } y descarta el RUT.
  async bloque(servicio, seleccionado = 'Actual', fecha = fechaIcr()) {
    const j = await this._planillon({ accion: 'planillon_bloque_actual', servicio, bloqueseleccionado: seleccionado, fecha });
    const salidas = (j.detalle ?? []).map((d) => ({
      servicio,
      hora: hhmm(d.hora),
      despacho: hhmm(d.horadespacho),
      real: hhmm(d.horareal),
      ppu: String(d.ppu ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null,
      tipoBus: d.tipoBus ?? null,
      estado: d.estado ?? null,
      iddespacho: d.iddespacho && d.iddespacho !== '0' ? String(d.iddespacho) : null,
      conductor: nombreCorto(d.nombreconductor),
      // d.conductor (RUT) se descarta a propósito.
    }));
    return { id: String(j.id ?? seleccionado), bloque: String(j.bloque ?? ''), salidas };
  }
}

/// Bloque en curso (por la hora de Chile) y sus vecinos. `idx` = posición en la lista.
export function bloqueDeAhora(bloques, minuto = minutoChile()) {
  const idx = bloques.findIndex((b) => minuto >= b.desde && minuto <= b.hasta);
  if (idx < 0) return null;
  return { idx, actual: bloques[idx], anterior: bloques[idx - 1] ?? null, siguiente: bloques[idx + 1] ?? null };
}
