// Recorridos F10 y F13 (Red Movilidad): trazado de ida (Juanita → Camilo Henríquez) y regreso
// (Camilo Henríquez → Juanita). Se bajan de red.cl una vez al día y quedan guardados en
// config/rutasRed (Firestore no acepta listas dentro de listas: se guardan como lat,lng,lat,lng…).
//
// Con eso, para cada bus en ruta se calcula en qué recorrido y sentido va, y cuántos km le faltan.

const RUTAS = ['F10', 'F13'];
const url = (r) => `https://www.red.cl/restservice_v2/rest/conocerecorrido?codsint=${r}`;
const DIA = 24 * 3600 * 1000;
const MAX_DIST_RUTA = 120; // metros: más lejos que esto del trazado = no va en ese recorrido
const MIN_AVANCE = 40; // metros que tiene que avanzar entre pasadas para saber el sentido

function metros(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/// [[lat,lng]…] o [{lat,lng}…] → plano [lat,lng,lat,lng…] (corrige si vienen al revés).
function aPlano(path) {
  const out = [];
  for (const p of path ?? []) {
    let lat = Array.isArray(p) ? p[0] : p?.lat;
    let lng = Array.isArray(p) ? p[1] : (p?.lng ?? p?.lon);
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (lat < -60) [lat, lng] = [lng, lat]; // venía lng,lat
    out.push(Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6);
  }
  return out;
}

/// Plano → puntos con km acumulados.
function desplegar(plano) {
  const pts = [];
  let km = 0;
  for (let i = 0; i + 1 < plano.length; i += 2) {
    const p = { lat: plano[i], lng: plano[i + 1] };
    if (pts.length) km += metros(pts[pts.length - 1], p) / 1000;
    pts.push({ ...p, km });
  }
  return { pts, total: km };
}

/// Trazados listos para usar: { F10: { ida: {pts,total}, regreso: {...} }, F13: … } o null.
export async function cargarRutas(db, FieldValue) {
  const ref = db.doc('config/rutasRed');
  const g = (await ref.get()).data();
  const fresco = g?.rutas && g?.fecha?.toMillis && Date.now() - g.fecha.toMillis() < DIA;
  let planos = g?.rutas ?? null;
  if (!fresco) {
    try {
      const nuevos = {};
      for (const r of RUTAS) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const resp = await fetch(url(r), { signal: c.signal }).finally(() => clearTimeout(t));
        if (!resp.ok) throw new Error(`red.cl respondió ${resp.status} para ${r}`);
        const j = await resp.json();
        nuevos[r] = { ida: aPlano(j.ida?.path), regreso: aPlano(j.regreso?.path) };
        if (nuevos[r].ida.length < 20 || nuevos[r].regreso.length < 20) throw new Error(`trazado de ${r} vino vacío`);
      }
      planos = nuevos;
      await ref.set({ rutas: nuevos, fecha: FieldValue.serverTimestamp() });
      console.log('Rutas Red: trazados F10 y F13 actualizados.');
    } catch (e) {
      console.warn('Rutas Red: no se pudieron bajar los trazados:', e.message, planos ? '(uso los guardados)' : '');
    }
  }
  if (!planos) return null;
  const rutas = {};
  for (const [r, s] of Object.entries(planos)) rutas[r] = { ida: desplegar(s.ida), regreso: desplegar(s.regreso) };
  return rutas;
}

/// Punto más cercano del trazado: { dist (m), km (avance desde el inicio) }.
function proyectar(t, p) {
  let mejor = { dist: Infinity, km: 0 };
  const rad = Math.PI / 180;
  const cos = Math.cos(p.lat * rad);
  for (let i = 0; i + 1 < t.pts.length; i++) {
    const a = t.pts[i];
    const b = t.pts[i + 1];
    // Plano local en metros con origen en a.
    const bx = (b.lng - a.lng) * cos * 111320;
    const by = (b.lat - a.lat) * 110540;
    const px = (p.lng - a.lng) * cos * 111320;
    const py = (p.lat - a.lat) * 110540;
    const l2 = bx * bx + by * by;
    const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / l2));
    const dx = px - u * bx;
    const dy = py - u * by;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < mejor.dist) mejor = { dist: d, km: a.km + (u * Math.sqrt(l2)) / 1000 };
  }
  return mejor;
}

/**
 * En qué recorrido y sentido va el bus, comparando con su posición anterior.
 * Devuelve { ruta, sentido: 'ida'|'regreso', faltaKm, totalKm } o null si no va por F10/F13.
 *   ida = de Juanita hacia Camilo Henríquez (vuelve al terminal); regreso = hacia Juanita.
 */
export function ubicarEnRuta(rutas, actual, antes, previo) {
  if (!rutas || actual?.lat == null || actual?.lng == null) return null;
  const cand = [];
  for (const [ruta, s] of Object.entries(rutas)) {
    for (const sentido of ['ida', 'regreso']) {
      const t = s[sentido];
      const ahora = proyectar(t, actual);
      if (ahora.dist > MAX_DIST_RUTA) continue;
      const pre = antes?.lat != null ? proyectar(t, antes) : null;
      const avance = pre && pre.dist <= MAX_DIST_RUTA ? (ahora.km - pre.km) * 1000 : null;
      cand.push({ ruta, sentido, dist: ahora.dist, km: ahora.km, total: t.total, avance });
    }
  }
  if (!cand.length) return null;
  // 1) El que avanza hacia adelante; 2) si está detenido, el mismo de la pasada anterior; 3) el más cercano.
  const avanzando = cand.filter((c) => c.avance != null && c.avance >= MIN_AVANCE);
  let elegido;
  if (avanzando.length) {
    elegido = avanzando.find((c) => c.ruta === previo?.ruta) ?? avanzando.sort((a, b) => a.dist - b.dist)[0];
  } else {
    elegido = cand.find((c) => c.ruta === previo?.ruta && c.sentido === previo?.sentido) ??
      cand.sort((a, b) => a.dist - b.dist)[0];
    // Sin movimiento ni historia no se sabe el sentido: mejor no decir nada.
    if (!previo && !avanzando.length) return null;
  }
  return {
    ruta: elegido.ruta,
    sentido: elegido.sentido,
    faltaKm: Math.round((elegido.total - elegido.km) * 10) / 10,
    totalKm: Math.round(elegido.total * 10) / 10,
  };
}
