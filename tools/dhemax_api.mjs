// Cliente de SOLO LECTURA de la plataforma de monitoreo de los cargadores (Dhemax, https://pge.dhemax.cl).
// Lo usan dhemax_espiar.mjs (en el PC) y, cuando esté, el robot de GitHub.
//
// Cómo funciona (visto en los HAR del 24-11):
//   - Login: POST /auth/login con JSON {email, password} → {access_token}. Es un JWT que dura 30 días y va
//     tal cual (sin "Bearer") en la cabecera Authorization.
//   - Cargadores: GET /CargadoresManguera → los 13 del terminal (ST_CH_101…107 = B7…B13 en ML1,
//     ST_CH_201…206 = A1…A6 en ML2), con sus mangueras (1 = L, 2 = R).
//   - Cargas de un día: POST /datosInformeCargaCargador {fecha: 'AAAA-MM-DDT11:00:00.000Z', cargadores, empresa_id: -1}.
//     El día es el del turno: las cargas de madrugada vienen en el día anterior. Cada carga trae el tr_id
//     (transacción OCPP = "Número de serie" del registro del cargador) y el SoC y el contador de energía al
//     partir y al terminar, con hora UTC.
//   - En vivo: GET /lineasTerminal/140 → estado de cada manguera (Available, Charging…), SoC, kW y la hora del
//     último dato.
//
// OJO: la cuenta del terminal tiene el permiso "Comandos OCPP y Tecles" (puede mandar órdenes a los cargadores).
// Este cliente SOLO puede llamar lo de la lista PERMITIDOS; cualquier otra ruta lanza error sin conectarse.
// El token y la respuesta del login nunca se muestran ni se guardan.

export const BASE = 'https://pge.dhemax.cl:3004';
export const TERMINAL = 140;

const PERMITIDOS = new Set([
  'POST auth/login',
  'GET CargadoresManguera',
  'POST datosInformeCargaCargador',
  `GET lineasTerminal/${TERMINAL}`,
]);

/// Falla de red (servidor caído, sin conexión, tiempo agotado): no va a ERRORES.
export function esErrorDeRed(e) {
  const t = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
  return /AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR|socket hang up|network/i
    .test(t);
}

export class ErrorDhemax extends Error {
  constructor(mensaje, { sesion = false, status = null } = {}) {
    super(mensaje);
    this.sesion = sesion;
    this.status = status;
  }
}

/// Pistola del semáforo para un cargador y manguera de Dhemax: ('ST_CH_105', 2) → 'B11-R'.
/// Comprobado el 24-11 cruzando 378 cargas con el SGDC.
export function pistolaDe(cargador, manguera) {
  const m = /^ST_CH_(\d)(\d\d)$/.exec(String(cargador));
  if (!m) return null;
  const n = Number(m[2]);
  const lado = Number(manguera) === 1 ? 'L' : Number(manguera) === 2 ? 'R' : null;
  if (!lado) return null;
  if (m[1] === '1' && n >= 1 && n <= 7) return `B${n + 6}-${lado}`;
  if (m[1] === '2' && n >= 1 && n <= 6) return `A${n}-${lado}`;
  return null;
}

/// "2026-11-23 11:44:08" (UTC, sin zona) o "2026-11-23T11:44:08.000+00:00" → Date.
function fechaUtc(s) {
  if (!s) return null;
  const t = String(s).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export class SesionDhemax {
  constructor(usuario, clave, { espera = 30000 } = {}) {
    this.usuario = usuario;
    this.clave = clave;
    this.espera = espera;
    this.token = null;
    this.cargadores = null;
  }

  async #pedir(metodo, ruta, cuerpo, { conToken = true } = {}) {
    if (!PERMITIDOS.has(`${metodo} ${ruta}`)) throw new Error(`Ruta no permitida en el cliente de solo lectura: ${metodo} ${ruta}`);
    const r = await fetch(`${BASE}/${ruta}`, {
      method: metodo,
      headers: {
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        ...(conToken && this.token ? { Authorization: this.token } : {}),
        Origin: 'https://pge.dhemax.cl',
        Referer: 'https://pge.dhemax.cl/',
        Accept: 'application/json',
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(this.espera),
    });
    if (r.status === 401 || r.status === 403) throw new ErrorDhemax(`Dhemax respondió ${r.status}`, { sesion: true, status: r.status });
    if (!r.ok) throw new ErrorDhemax(`Dhemax respondió ${r.status} en ${ruta}`, { status: r.status });
    try {
      return await r.json();
    } catch {
      throw new ErrorDhemax(`Dhemax mandó algo que no es JSON en ${ruta}`);
    }
  }

  async entrar() {
    this.token = null;
    const r = await this.#pedir('POST', 'auth/login', { email: this.usuario, password: this.clave }, { conToken: false });
    if (!r?.access_token) throw new ErrorDhemax('Dhemax rechazó el usuario o la contraseña', { sesion: true });
    this.token = r.access_token;
  }

  /// Pide con la sesión; si venció, entra de nuevo una vez y repite.
  async #conSesion(metodo, ruta, cuerpo) {
    if (!this.token) await this.entrar();
    try {
      return await this.#pedir(metodo, ruta, cuerpo);
    } catch (e) {
      if (!(e instanceof ErrorDhemax) || !e.sesion) throw e;
      await this.entrar();
      return this.#pedir(metodo, ruta, cuerpo);
    }
  }

  /// Los 13 cargadores del terminal (tal como los pide la página para el informe).
  async listaCargadores() {
    const l = await this.#conSesion('GET', 'CargadoresManguera');
    if (!Array.isArray(l)) throw new ErrorDhemax('CargadoresManguera no devolvió una lista');
    this.cargadores = l;
    return l;
  }

  /// Cargas del día del turno [dia] ('AAAA-MM-DD'), una por transacción.
  /// { tr, cargador, manguera, pistola, inicio, fin, socIni, socFin, kwh, iniCarga, finCarga }
  /// inicio/fin = cuando el medidor partió y paró (lo mismo que muestra el Excel de la página).
  async cargasDelDia(dia) {
    const cargadores = this.cargadores ?? (await this.listaCargadores());
    const datos = await this.#conSesion('POST', 'datosInformeCargaCargador', {
      fecha: `${dia}T11:00:00.000Z`,
      cargadores,
      empresa_id: -1,
    });
    if (!Array.isArray(datos)) throw new ErrorDhemax('datosInformeCargaCargador no devolvió una lista');
    const out = [];
    for (const el of datos) {
      const cargador = el?.cargador?.nombre;
      for (const c of el?.datos_carga ?? []) {
        const d = c.data ?? {};
        const kIni = num(d.kwh_ini?.valor);
        const kFin = num(d.kwh_fin?.valor);
        out.push({
          tr: d.soc_ini?.tr_id ?? d.kwh_ini?.tr_id ?? d.soc_fin?.tr_id ?? d.kwh_fin?.tr_id ?? null,
          cargador,
          manguera: c.numero_manguera,
          pistola: pistolaDe(cargador, c.numero_manguera),
          inicio: fechaUtc(d.kwh_ini?.fecha) ?? fechaUtc(c.fecha_ini_charging),
          fin: fechaUtc(d.kwh_fin?.fecha) ?? fechaUtc(c.fecha_fin_charging),
          socIni: num(d.soc_ini?.valor),
          socFin: num(d.soc_fin?.valor),
          kwh: kIni != null && kFin != null ? Math.round((kFin - kIni) * 100) / 100 : null,
          iniCarga: fechaUtc(c.fecha_ini_charging),
          finCarga: fechaUtc(c.fecha_fin_charging),
          dia: c.dia ?? dia,
        });
      }
    }
    return out;
  }

  /// Estado en vivo de cada manguera: { cargador, manguera, pistola, estado, error, soc, kw, dato }.
  async enVivo() {
    const lineas = await this.#conSesion('GET', `lineasTerminal/${TERMINAL}`);
    if (!Array.isArray(lineas)) throw new ErrorDhemax('lineasTerminal no devolvió una lista');
    const out = [];
    for (const l of lineas) {
      for (const q of l?.equipos ?? []) {
        for (const m of q?.mangueras ?? []) {
          const u = m.ultimos_datos_mangueras ?? {};
          const a = m.actual_alarmas_manguera ?? {};
          out.push({
            cargador: q.nombre,
            manguera: m.numero_manguera,
            pistola: pistolaDe(q.nombre, m.numero_manguera),
            conectado: q.estado_conexion === 1,
            estado: a.estado ?? null,
            error: a.codigo_error && a.codigo_error !== 'NoError' ? a.codigo_error : null,
            soc: num(u.soc),
            kw: num(u.potencia_dc),
            dato: fechaUtc(u.updated_at),
          });
        }
      }
    }
    return out;
  }
}

/// "2026-11-24" para la fecha de Chile de [d].
export const diaChile = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
