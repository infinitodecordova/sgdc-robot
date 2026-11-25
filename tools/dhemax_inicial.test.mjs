// Pruebas del % inicial con Dhemax:  node --test tools/dhemax_inicial.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cargasRecientes, decidir } from './dhemax_inicial.mjs';

const t = (h, m) => Date.UTC(2026, 10, 25, h + 3, m); // hora de Chile (UTC-3) del 25-11
const carga = (p, ini, si, fin = ini + 60000, ap = ini + 4 * 60000) => ({ p, ini, si, fin, ap });
const anotar = (fecha, p, pct, quien = 'joaquin') => ({
  fecha, usuario: quien, nombre: quien,
  cambios: { coordenada: { antes: null, despues: p }, ...(pct != null ? { pctInicial: { antes: null, despues: pct } } : {}) },
});

test('SRPK19 (25-11): anotó 32 con digiCAR 16 min antes; Dhemax 41 → se corrige', () => {
  const c = carga('B8-L', t(10, 2), 41);
  const r = decidir({ coordenada: 'B8-L', pctInicial: 32 }, c, [anotar(t(9, 46), 'B8-L', 32)], { a: c }, null);
  assert.deepEqual(r.cambios, { pctInicial: { antes: 32, despues: 41 } });
});

test('dentro de 2 puntos no se toca', () => {
  const c = carga('B9-L', t(13, 22), 58);
  const r = decidir({ coordenada: 'B9-L', pctInicial: 57 }, c, [anotar(t(13, 19), 'B9-L', 57)], { a: c }, null);
  assert.equal(r.cambios, undefined);
});

test('pistola anotada sin %: se rellena', () => {
  const c = carga('A6-L', t(14, 5), 60);
  const r = decidir({ coordenada: 'A6-L', pctInicial: null }, c, [anotar(t(14, 3), 'A6-L', null)], { a: c }, null);
  assert.deepEqual(r.cambios, { pctInicial: { antes: null, despues: 60 } });
});

test('reconexión: hubo otra carga en esa pistola después de anotar → no se toca', () => {
  const primera = carga('B11-R', t(12, 14), 67);
  const segunda = carga('B11-R', t(12, 40), 80);
  const r = decidir({ coordenada: 'B11-R', pctInicial: 67 }, segunda, [anotar(t(12, 5), 'B11-R', 65)],
    { a: primera, b: segunda }, null);
  assert.match(r.no, /reconexión/);
});

test('la carga del bus anterior en la pistola (antes de anotar) no cuenta como reconexión', () => {
  const anterior = carga('A6-L', t(9, 57), 87);
  const c = carga('A6-L', t(11, 17), 58);
  const r = decidir({ coordenada: 'A6-L', pctInicial: 52 }, c, [anotar(t(11, 5), 'A6-L', 52)], { a: anterior, b: c }, null);
  assert.deepEqual(r.cambios, { pctInicial: { antes: 52, despues: 58 } });
});

test('una persona cambió el % después de anotar → no se pisa', () => {
  const c = carga('A1-L', t(9, 55), 34);
  const h = [
    { fecha: t(10, 10), usuario: 'joaquin', nombre: 'Joaquín', cambios: { pctInicial: { antes: 28, despues: 30 } } },
    anotar(t(9, 46), 'A1-L', 28),
  ];
  const r = decidir({ coordenada: 'A1-L', pctInicial: 30 }, c, h, { a: c }, null);
  assert.match(r.no, /ya cambiado/);
});

test('pistola anotada hace más de 60 min (otra carga, otro rato) → no se toca', () => {
  const c = carga('A6-R', t(12, 43), 45);
  const r = decidir({ coordenada: 'A6-R', pctInicial: 68 }, c, [anotar(t(9, 58), 'A6-R', 68)], { a: c }, null);
  assert.match(r.no, /lejos/);
});

test('anotado antes del último cierre → no se toca', () => {
  const c = carga('B13-L', t(20, 10), 50);
  const r = decidir({ coordenada: 'B13-L', pctInicial: 40 }, c, [anotar(t(19, 50), 'B13-L', 40)], { a: c }, t(20, 5));
  assert.match(r.no, /cierre/);
});

test('el bus está en otra pistola → no se toca', () => {
  const c = carga('B13-L', t(13, 56), 49);
  const r = decidir({ coordenada: 'B12-L', pctInicial: 45 }, c, [anotar(t(13, 55), 'B12-L', 45)], { a: c }, null);
  assert.match(r.no, /otra pistola/);
});

test('cargasRecientes: solo en curso, recién partidas y con %', () => {
  const ahora = t(14, 10);
  const l = cargasRecientes([
    carga('A6-L', t(14, 5), 60, t(14, 9)), // sí
    carga('A6-R', t(13, 20), 50, t(14, 9)), // partió hace 50 min
    carga('B8-L', t(14, 0), 55, t(13, 58)), // sin lectura hace 12 min: terminó
    carga('B9-L', t(14, 6), null, t(14, 9)), // sin %
    carga('ST_CH_101/1', t(14, 6), 40, t(14, 9)), // sin pistola conocida
    carga('B7-R', t(13, 52), 61, t(14, 9), t(14, 10)), // Dhemax la registró 18 min tarde (SRRX41 25-11: 61 vs 53 real)
  ], ahora);
  assert.deepEqual(l.map((c) => c.p), ['A6-L']);
});
