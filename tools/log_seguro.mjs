// Recorte seguro de lo que responde un servidor, para ponerlo en errores y logs. El log de GitHub Actions es
// público: nunca debe llevar tokens, claves ni RUT, ni mucho texto del proveedor.

const PATRONES = [
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, // JWT
  /\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]/g, // RUT
  /bearer\s+[\w.~+\/=-]+/gi, // Bearer <token>
  /["']?(?:token|password|clave|bearer|authorization|secret|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, // "token": "abc"
  /(token|password|clave|bearer|authorization)\S*/gi, // lo que quede pegado a esas palabras
];

/// Tapa tokens, claves y RUT del texto (antes de recortar, para que no quede un pedazo a la vista).
export function taparSecretos(texto) {
  let t = String(texto ?? '');
  for (const p of PATRONES) t = t.replace(p, '[oculto]');
  return t;
}

/// Un recorte corto (por defecto 80 caracteres, en una línea) del texto de un servidor, con los secretos tapados.
export function recorteSeguro(texto, max = 80) {
  const t = taparSecretos(texto).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
