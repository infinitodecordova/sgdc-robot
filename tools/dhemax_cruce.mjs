// Cruce de lo anotado en el semáforo con las cargas reales de los cargadores (Dhemax).
// Lo usan revision_turnos.mjs (avisa), cierre_automatico.mjs (corrige si el SGDC no está al día) y
// revisar_con_dhemax.mjs (revisión hacia atrás). Sin Firestore: funciones puras + la descarga de Dhemax.
//
// Dhemax sabe pistola, hora, % y kWh de cada carga, pero NO qué bus cargó. El dueño de cada carga sale de:
//   1. El SGDC: si tiene una carga en la misma pistola que termina a ±5 min (o parte a ±20 min), su patente
//      es la del bus ("confirmada"). Ojo: el SGDC a veces trae la patente mal digitada en el cargador.
//   2. Lo anotado por el bombero: misma pistola y % inicial parecido ("probable"). Si dos cargas de esa
//      pistola calzan casi igual de bien, queda "ambigua" y no se usa para corregir.
// Cargas seguidas en la misma pistola (la siguiente parte a <45 min y en el % donde quedó la anterior) son
// el mismo bus reconectado: se juntan en una sola (primer % inicial → último % final, kWh sumados).
// Los intentos fallidos (<1 kWh) no cuentan. Si un bus no tiene carga en su pistola y en otra hay una sin
// anotar con su mismo % inicial, se sugiere que la pistola se anotó mal (SRPK75 20-11: A1-L → A2-L).
// Cargas en curso: Dhemax ya las trae, con fin = última lectura del medidor (~cada 5 min) y sf/kwh subiendo
// (visto el 24-11). marcarEnCurso() las marca con `enCurso` (pistola "Charging" en el vivo); su % final no es
// definitivo y no se usa para corregir.
// Ojo: cerca del 100 % Dhemax marca 1–3 puntos menos (el último SoC se lee antes del término); quien
// compare % finales tiene que aceptarlo (calzaFinal).
// Comprobado el 24-11-2026: 378/402 cargas del SGDC calzan con Dhemax (las 24 restantes eran de un día
// que no se pidió) y 19/20 cargas completadas a mano desde el registro del cargador son idénticas.

import { SesionDhemax, diaChile } from './dhemax_api.mjs';

export const PISTOLAS = new Set([
  'B7-L', 'B7-R', 'B8-L', 'B8-R', 'B9-L', 'B9-R', 'B10-L', 'B10-R', 'B11-L', 'B11-R',
  'B12-L', 'B12-R', 'B13-L', 'B13-R', 'A1-L', 'A1-R', 'A2-L', 'A2-R', 'A3-L', 'A3-R',
  'A4-L', 'A4-R', 'A5-L', 'A5-R', 'A6-L', 'A6-R',
]);

const MIN = 60000;
const DUENO_FIN_MIN = 5; // SGDC y Dhemax terminan casi al mismo segundo (mediana 0 min)
const DUENO_INICIO_MIN = 20; // el SGDC a veces parte varios minutos tarde
const RECONEXION_MIN = 45; // hueco máximo entre dos cargas del mismo bus en la misma pistola (SRPK28 19-11: 25 min)
const RECONEXION_PCT = 5; // la siguiente parte en el % donde quedó la anterior (±; el último SoC llega atrasado)
const KWH_MIN = 1; // menos que esto es un intento fallido (SRSC39 22-11: 1 min, 0 kWh): no cuenta como carga
export const OTRA_PISTOLA_PCT = 3; // % inicial para sugerir que la pistola se anotó mal
export const PROBABLE_PCT = 5; // % inicial anotado vs el del cargador para "probable"
export const ESTRICTO_PCT = 3; // para corregir sin preguntar (cierre automático)
const AMBIGUO_PCT = 2; // si otro reparto calza a menos de esto del mejor y cambia una carga de dueño, es ambigua
const PESO_FINAL = 0.5; // el % final pesa la mitad (a veces se anota la meta), y como máximo 10 puntos
const SIN_CARGA = 12; // costo de dejar un bus sin carga: siempre conviene asignar una que calce
const MAX_REPARTOS = 20000;

const norma = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ms = (d) => (d == null ? null : d instanceof Date ? d.getTime() : d?.toDate ? d.toDate().getTime() : Number(d));

// ------------------------------------------------------------------ descarga

let sesion = null;
const porDia = new Map(); // día de turno → { p: Promise<cargas>, t } (una descarga por día cada 5 min)
const CACHE_MS = 5 * MIN; // el vigilante vive ~55 min: sin esto la revisión usaría lo bajado en el cierre

/// ¿Hay usuario y clave de Dhemax en esta corrida?
export const hayDhemax = () => !!(process.env.DHEMAX_USUARIO && process.env.DHEMAX_CLAVE);

/// Cargas de Dhemax que parten en [desde, hasta). Pide los días de turno que tocan (el día de turno de
/// Dhemax incluye la madrugada siguiente), cada uno una sola vez por corrida. Lanza si Dhemax falla.
export async function cargasDhemaxEntre(desde, hasta) {
  if (!hayDhemax()) throw new Error('Faltan DHEMAX_USUARIO / DHEMAX_CLAVE');
  sesion ??= new SesionDhemax(process.env.DHEMAX_USUARIO, process.env.DHEMAX_CLAVE);
  const a = ms(desde), b = ms(hasta);
  const dias = new Set([diaChile(new Date(a - 86400000)), diaChile(new Date(a)), diaChile(new Date(b))]);
  const listas = await Promise.all([...dias].map((d) => {
    if (!porDia.has(d) || Date.now() - porDia.get(d).t > CACHE_MS) {
      const p = sesion.cargasDelDia(d);
      p.catch(() => porDia.delete(d)); // si falla, que se pueda reintentar
      porDia.set(d, { p, t: Date.now() });
    }
    return porDia.get(d).p;
  }));
  const unicas = new Map();
  for (const c of listas.flat()) {
    const i = ms(c.inicio);
    if (c.tr == null || i == null || i < a || i >= b || !c.pistola) continue;
    unicas.set(String(c.tr), { ...c }); // copia: marcarEnCurso no toca la caché
  }
  return [...unicas.values()].sort((x, y) => ms(x.inicio) - ms(y.inicio));
}

const EN_CURSO_SIN_VIVO_MIN = 10; // sin el vivo: en curso si la última lectura es de hace menos que esto

/// Marca `enCurso` en las cargas que siguen cargando: la última de cada pistola que está "Charging" en el vivo.
/// Si el vivo no responde, las que tienen la última lectura de hace menos de 10 min (por si acaso).
/// Devuelve cuántas marcó. Solo hace falta cerca del fin del turno (cierre automático).
export async function marcarEnCurso(cargas, ahora = Date.now()) {
  let cargando = null;
  try {
    sesion ??= new SesionDhemax(process.env.DHEMAX_USUARIO, process.env.DHEMAX_CLAVE);
    cargando = new Set((await sesion.enVivo()).filter((m) => m.pistola && /charg/i.test(m.estado ?? '')).map((m) => m.pistola));
  } catch {
    cargando = null;
  }
  const ultima = new Map();
  for (const c of cargas) {
    const u = ultima.get(c.pistola);
    if (!u || ms(c.inicio) > ms(u.inicio)) ultima.set(c.pistola, c);
  }
  let n = 0;
  for (const c of cargas) {
    c.enCurso = cargando
      ? cargando.has(c.pistola) && ultima.get(c.pistola) === c
      : ms(c.fin ?? c.inicio) > ahora - EN_CURSO_SIN_VIVO_MIN * MIN;
    if (c.enCurso) n++;
  }
  return n;
}

// ------------------------------------------------------------------ cruce

/// Une las cargas seguidas del mismo bus en la misma pistola (reconexiones).
function sesiones(cargas) {
  const porPistola = new Map();
  for (const c of [...cargas].sort((x, y) => ms(x.inicio) - ms(y.inicio))) {
    const l = porPistola.get(c.pistola) ?? [];
    const u = l[l.length - 1];
    const sigue = u && ms(c.inicio) - ms(u.fin ?? u.inicio) < RECONEXION_MIN * MIN &&
      c.socIni != null && u.sf != null && Math.abs(c.socIni - u.sf) <= RECONEXION_PCT &&
      (!u.ppuSgdc || !c.ppuSgdc || u.ppuSgdc === c.ppuSgdc);
    if (sigue) {
      u.sf = c.socFin ?? u.sf;
      u.fin = ms(c.fin) ?? u.fin;
      u.kwh = Math.round(((u.kwh ?? 0) + (c.kwh ?? 0)) * 100) / 100;
      u.tr.push(c.tr);
      u.ppuSgdc ??= c.ppuSgdc ?? null;
      u.enCurso = !!c.enCurso;
    } else {
      l.push({
        pistola: c.pistola, si: c.socIni, sf: c.socFin, kwh: c.kwh, ini: ms(c.inicio), fin: ms(c.fin),
        tr: [c.tr], ppuSgdc: c.ppuSgdc ?? null, enCurso: !!c.enCurso,
      });
    }
    porPistola.set(c.pistola, l);
  }
  return [...porPistola.values()].flat();
}

/// Patente del SGDC para cada carga de Dhemax (misma pistola, términos a ±5 min o inicios a ±20 min).
function duenosSgdc(dhemax, sgdc) {
  const out = dhemax.map((d) => ({ ...d, ppuSgdc: null }));
  for (const d of out) {
    let mejor = null;
    for (const g of sgdc) {
      if (g.pistola !== d.pistola) continue;
      const dFin = g.fin && d.fin ? Math.abs(ms(g.fin) - ms(d.fin)) : Infinity;
      const dIni = g.inicio && d.inicio ? Math.abs(ms(g.inicio) - ms(d.inicio)) : Infinity;
      if (dFin > DUENO_FIN_MIN * MIN && dIni > DUENO_INICIO_MIN * MIN) continue;
      const score = Math.min(dFin, dIni);
      if (!mejor || score < mejor.score) mejor = { score, ppu: norma(g.ppu) };
    }
    d.ppuSgdc = mejor?.ppu ?? null;
  }
  return out;
}

/**
 * Empareja los buses anotados con las cargas de Dhemax de un turno.
 * @param buses [{ id, ppu, coordenada, pctInicial, pctFinal }] (la foto del turno o el semáforo)
 * @param dhemax cargas de Dhemax del turno (de cargasDhemaxEntre)
 * @param sgdc cargas del SGDC del turno [{ ppu, pistola, inicio, fin }] (puede ir vacío si el SGDC cayó)
 * @returns { porBus: Map(id → resultado), sinAnotar: [sesión] }
 *   resultado = { estado: 'confirmada'|'probable'|'ambigua'|'sin_carga', estricta, carga, opciones }
 *   carga = { pistola, si, sf, kwh, ini, fin (ms), tr: [..], ppuSgdc, enCurso }
 */
export function emparejar(buses, dhemax, sgdc = []) {
  const ses = sesiones(duenosSgdc(dhemax.filter((c) => (c.kwh ?? 0) >= KWH_MIN), sgdc));
  const usadas = new Set();
  const porBus = new Map();
  const conPistola = buses.filter((b) => PISTOLAS.has(b.coordenada));
  const ppus = new Set(conPistola.map((b) => norma(b.ppu ?? b.id)));

  // 1. Confirmadas por el SGDC: la carga de esa pistola tiene la patente del bus.
  for (const b of conPistola) {
    const ppu = norma(b.ppu ?? b.id);
    const c = ses.filter((s) => s.pistola === b.coordenada && s.ppuSgdc === ppu && !usadas.has(s))
      .sort((x, y) => Math.abs((x.si ?? 0) - (b.pctInicial ?? x.si ?? 0)) - Math.abs((y.si ?? 0) - (b.pctInicial ?? y.si ?? 0)))[0];
    if (!c) continue;
    usadas.add(c);
    // Para corregir sin preguntar, además el % inicial tiene que calzar (si el bus cargó dos veces en el turno,
    // esta puede no ser la primera).
    const estricta = b.pctInicial == null || c.si == null || Math.abs(c.si - b.pctInicial) <= ESTRICTO_PCT;
    porBus.set(b.id ?? ppu, { estado: 'confirmada', estricta, carga: c, opciones: [c] });
  }

  // 2. Las demás, pistola por pistola: el reparto de sus cargas libres entre sus buses que mejor calza en
  //    conjunto (% inicial y, con menos peso, % final; así 60→89 y 59→85 no se cruzan como el 09-11 en B11-L).
  //    Si otro reparto calza casi igual de bien (a menos de AMBIGUO_PCT) y cambia de dueño una carga, esos buses
  //    quedan "ambigua": no se adivina. Solo cargas sin dueño en el SGDC o con un dueño que no está anotado
  //    (patente mal digitada).
  const libre = (s) => !usadas.has(s) && (!s.ppuSgdc || !ppus.has(s.ppuSgdc));
  //    Los buses sin % inicial anotado no entran al reparto (le quitarían la certeza a los demás, 08-11): van
  //    al final y solo se quedan con una carga si es la única que sobra en su pistola.
  const porPistola = new Map();
  const sinInicial = [];
  for (const b of conPistola) {
    if (porBus.has(b.id ?? norma(b.ppu))) continue;
    if (b.pctInicial == null) {
      sinInicial.push(b);
      continue;
    }
    if (!porPistola.has(b.coordenada)) porPistola.set(b.coordenada, []);
    porPistola.get(b.coordenada).push(b);
  }
  for (const [pistola, bs] of porPistola) {
    const cand = ses.filter((x) => x.pistola === pistola && libre(x));
    if (!cand.length) continue;
    const costo = (b, x) => {
      if (x.si == null) return null;
      let c = Math.abs(x.si - b.pctInicial);
      if (c > PROBABLE_PCT) return null;
      if (b.pctFinal != null && x.sf != null) c += PESO_FINAL * Math.min(Math.abs(x.sf - b.pctFinal), 10);
      return c;
    };
    // Todos los repartos posibles (cada bus: una carga distinta o ninguna). Son pocos: ≤4 buses y ≤6 cargas.
    const repartos = [];
    const rec = (i, tomadas, total, asig) => {
      if (repartos.length >= MAX_REPARTOS) return;
      if (i === bs.length) {
        repartos.push({ total, asig });
        return;
      }
      rec(i + 1, tomadas, total + SIN_CARGA, [...asig, null]);
      for (const x of cand) {
        if (tomadas.has(x)) continue;
        const c = costo(bs[i], x);
        if (c == null) continue;
        tomadas.add(x);
        rec(i + 1, tomadas, total + c, [...asig, x]);
        tomadas.delete(x);
      }
    };
    rec(0, new Set(), 0, []);
    repartos.sort((a, z) => a.total - z.total);
    const mejor = repartos[0];
    const cerca = repartos.filter((r) => r.total < mejor.total + AMBIGUO_PCT);
    bs.forEach((b, i) => {
      const x = mejor.asig[i];
      if (!x) return;
      // ¿Hay un reparto casi igual de bueno en que este bus se lleva otra carga, o esta carga va a otro bus?
      const otras = new Set(cerca.map((r) => r.asig[i]).filter((y) => y && y !== x));
      const duenos = new Set(cerca.map((r) => r.asig.indexOf(x)).filter((k) => k >= 0));
      const id = b.id ?? norma(b.ppu);
      if (otras.size || duenos.size > 1) {
        porBus.set(id, { estado: 'ambigua', estricta: false, carga: null, opciones: [x, ...otras] });
        return;
      }
      usadas.add(x);
      porBus.set(id, { estado: 'probable', estricta: Math.abs(x.si - b.pctInicial) <= ESTRICTO_PCT, carga: x, opciones: [x] });
    });
  }
  // Sin % inicial: solo si en su pistola sobra una única carga libre (y ningún otro bus sin % la pide).
  for (const b of sinInicial) {
    const libres = ses.filter((x) => x.pistola === b.coordenada && libre(x));
    const otros = sinInicial.filter((y) => y !== b && y.coordenada === b.coordenada);
    if (libres.length === 1 && !otros.length) {
      usadas.add(libres[0]);
      porBus.set(b.id ?? norma(b.ppu), { estado: 'probable', estricta: false, carga: libres[0], opciones: [libres[0]] });
    }
  }

  for (const b of conPistola) {
    const id = b.id ?? norma(b.ppu);
    if (!porBus.has(id)) porBus.set(id, { estado: 'sin_carga', estricta: false, carga: null, opciones: [] });
  }

  // 3. Cargas que no son de ningún bus anotado ni tienen patente en el SGDC: alguien cargó y no quedó anotado.
  //    (Las que el SGDC sí tiene las revisa la revisión de turnos con la patente.) Solo cargas de verdad.
  const enAmbiguas = new Set([...porBus.values()].flatMap((r) => (r.estado === 'ambigua' ? r.opciones : [])));
  let sinAnotar = ses.filter((s) => !usadas.has(s) && !enAmbiguas.has(s) && !s.ppuSgdc &&
    (s.kwh ?? 0) >= 3 && s.si != null && s.sf != null && s.sf - s.si >= 2);

  // 4. ¿Pistola mal anotada? Bus sin carga en su pistola + una sola carga sin anotar con su % inicial.
  for (const b of conPistola) {
    const r = porBus.get(b.id ?? norma(b.ppu));
    // También lo que anotó el bombero antes de completarla a mano (rescate.anotadoInicial).
    const refs = [b.pctInicial, b.rescate?.anotadoInicial].filter((v) => v != null);
    if (r.estado !== 'sin_carga' || !refs.length) continue;
    const c = sinAnotar.filter((s) => refs.some((v) => Math.abs(s.si - v) <= OTRA_PISTOLA_PCT));
    if (c.length === 1) r.otraPistola = c[0];
  }
  const sugeridas = new Set([...porBus.values()].map((r) => r.otraPistola).filter(Boolean));
  sinAnotar = sinAnotar.filter((s) => !sugeridas.has(s));
  return { porBus, sinAnotar };
}

/// ¿El % final anotado calza con el del cargador? ±tol, y cerca del 100 % hasta 3 puntos más (Dhemax lee el
/// último SoC un poco antes de que termine: 20-11, el registro del cargador decía 100 donde Dhemax 98–99).
export function calzaFinal(anotado, cargador, tol = 2) {
  if (anotado == null || cargador == null) return true;
  const d = anotado - cargador;
  return Math.abs(d) <= tol || (cargador >= 94 && d > 0 && d <= 3);
}

/// "B12-R 08:58–09:45 72→100 % 99,65 kWh" (para logs y avisos). [hm] formatea una fecha en hora de Chile.
export function textoCarga(c, hm) {
  if (!c) return '—';
  return `${c.pistola} ${hm(new Date(c.ini))}–${c.fin && !c.enCurso ? hm(new Date(c.fin)) : '…'} ${c.si ?? '—'}→${c.sf ?? '—'} %` +
    `${c.kwh != null ? ` ${String(c.kwh).replace('.', ',')} kWh` : ''}${c.enCurso ? ' (sigue cargando)' : ''}`;
}

/// Resultado para guardar en Firestore (dhemaxTurnos/{turno}): lo que usa la app en "Cargas sin SGDC".
export function paraFirestore({ porBus, sinAnotar }) {
  const c = (s) => (s ? { p: s.pistola, si: s.si, sf: s.sf, kwh: s.kwh, ini: s.ini, fin: s.fin, tr: s.tr, ppuSgdc: s.ppuSgdc } : null);
  return {
    buses: Object.fromEntries([...porBus].map(([id, r]) => [id, {
      estado: r.estado, estricta: r.estricta, carga: c(r.carga), opciones: r.opciones.slice(0, 4).map(c),
      otraPistola: c(r.otraPistola ?? null),
    }])),
    sinAnotar: sinAnotar.map(c),
  };
}
