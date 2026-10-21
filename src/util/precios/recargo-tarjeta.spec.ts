import {
  calcularRecargoTarjeta,
  esMetodoTarjeta,
  normalizarPorcentajeRecargo,
  repartirRecargoPorAfectacion,
} from './recargo-tarjeta';

const tarjeta = (monto = 0) => ({ tarjeta: true, monto });
const otro = (monto = 0) => ({ tarjeta: false, monto });

describe('calcularRecargoTarjeta', () => {
  it('cobra el 3 % sobre toda la venta cuando es un solo pago con tarjeta', () => {
    expect(calcularRecargoTarjeta(51, [tarjeta()], 3)).toEqual({
      aplica: true,
      porcentaje: 3,
      base_tarjeta: 51,
      monto: 1.53,
    });
  });

  it('da lo mismo si la línea de tarjeta ya trae su monto con recargo', () => {
    expect(calcularRecargoTarjeta(51, [tarjeta(52.53)], 3)).toMatchObject({ base_tarjeta: 51, monto: 1.53 });
  });

  it('redondea el recargo al céntimo (19.60 × 3 % = 0.588 → 0.59)', () => {
    expect(calcularRecargoTarjeta(19.6, [tarjeta()], 3).monto).toBe(0.59);
  });

  it('en pago mixto solo recarga lo que queda para la tarjeta', () => {
    const r = calcularRecargoTarjeta(100, [otro(20), tarjeta()], 3);
    expect(r).toMatchObject({ aplica: true, base_tarjeta: 80, monto: 2.4 });
  });

  it('suma todos los medios que no son tarjeta, incluido el crédito', () => {
    const r = calcularRecargoTarjeta(100, [otro(20), otro(30), tarjeta()], 3);
    expect(r).toMatchObject({ base_tarjeta: 50, monto: 1.5 });
  });

  it('no recarga si los demás medios ya cubren la venta', () => {
    const r = calcularRecargoTarjeta(100, [otro(100), tarjeta()], 3);
    expect(r).toMatchObject({ aplica: false, base_tarjeta: 0, monto: 0 });
  });

  it('no recarga sin ningún pago con tarjeta', () => {
    expect(calcularRecargoTarjeta(100, [otro(100)], 3)).toMatchObject({ aplica: false, monto: 0 });
    expect(calcularRecargoTarjeta(100, [], 3)).toMatchObject({ aplica: false, monto: 0 });
  });

  it('con 0 % o un valor inválido el recargo queda desactivado', () => {
    expect(calcularRecargoTarjeta(100, [tarjeta()], 0).aplica).toBe(false);
    expect(calcularRecargoTarjeta(100, [tarjeta()], Number.NaN).aplica).toBe(false);
    expect(calcularRecargoTarjeta(100, [tarjeta()], -3).aplica).toBe(false);
  });

  it('ignora totales no positivos', () => {
    expect(calcularRecargoTarjeta(0, [tarjeta()], 3).aplica).toBe(false);
    expect(calcularRecargoTarjeta(-5, [tarjeta()], 3).aplica).toBe(false);
  });

  it('un monto negativo en otro medio no aumenta la base', () => {
    expect(calcularRecargoTarjeta(100, [otro(-50), tarjeta()], 3)).toMatchObject({ base_tarjeta: 100, monto: 3 });
  });
});

describe('normalizarPorcentajeRecargo', () => {
  it.each([
    [3, 3],
    ['3', 3],
    [3.456, 3.46],
    [0, 0],
    [-1, 0],
    ['abc', 0],
    [undefined, 0],
    [null, 0],
    [150, 100],
  ])('%p → %p', (entrada, esperado) => {
    expect(normalizarPorcentajeRecargo(entrada)).toBe(esperado);
  });
});

describe('esMetodoTarjeta', () => {
  it('reconoce por tipo o por nombre', () => {
    expect(esMetodoTarjeta({ tipo: 'tarjeta', nombre: 'POS' })).toBe(true);
    expect(esMetodoTarjeta({ tipo: '', nombre: 'Tarjeta de crédito' })).toBe(true);
    expect(esMetodoTarjeta({ tipo: 'efectivo', nombre: 'Efectivo' })).toBe(false);
    expect(esMetodoTarjeta({ tipo: 'credito', nombre: 'Crédito' })).toBe(false);
    expect(esMetodoTarjeta({})).toBe(false);
  });
});

describe('repartirRecargoPorAfectacion', () => {
  it('con productos gravados es un solo tramo gravado', () => {
    expect(repartirRecargoPorAfectacion([{ tipo_de_igv: 1, total: 10 }, { tipo_de_igv: 1, total: 5 }], 0.45)).toEqual([
      { tipo_de_igv: 1, monto: 0.45 },
    ]);
  });

  it('si todo es exonerado, el recargo también', () => {
    expect(repartirRecargoPorAfectacion([{ tipo_de_igv: 8, total: 40 }], 1.2)).toEqual([{ tipo_de_igv: 8, monto: 1.2 }]);
  });

  it('reparte en proporción cuando hay varios tratamientos', () => {
    const tramos = repartirRecargoPorAfectacion([{ tipo_de_igv: 1, total: 100 }, { tipo_de_igv: 8, total: 50 }], 4.5);
    expect(tramos).toEqual([
      { tipo_de_igv: 1, monto: 3 },
      { tipo_de_igv: 8, monto: 1.5 },
    ]);
  });

  it('el reparto siempre suma exactamente el recargo (restos al mayor residuo)', () => {
    const tramos = repartirRecargoPorAfectacion(
      [{ tipo_de_igv: 1, total: 33.33 }, { tipo_de_igv: 8, total: 33.33 }, { tipo_de_igv: 9, total: 33.34 }],
      1,
    );
    expect(tramos).toEqual([
      { tipo_de_igv: 1, monto: 0.33 },
      { tipo_de_igv: 8, monto: 0.33 },
      { tipo_de_igv: 9, monto: 0.34 },
    ]);
    expect(tramos.reduce((suma, t) => suma + Math.round(t.monto * 100), 0)).toBe(100);
  });

  it('no deja céntimos sueltos con montos pequeños', () => {
    const tramos = repartirRecargoPorAfectacion([{ tipo_de_igv: 1, total: 1 }, { tipo_de_igv: 8, total: 1 }], 0.01);
    expect(tramos).toHaveLength(1);
    expect(tramos[0].monto).toBe(0.01);
  });

  it('sin recargo o sin líneas con valor devuelve lo que corresponde', () => {
    expect(repartirRecargoPorAfectacion([{ tipo_de_igv: 1, total: 10 }], 0)).toEqual([]);
    expect(repartirRecargoPorAfectacion([], 1.5)).toEqual([{ tipo_de_igv: 1, monto: 1.5 }]);
  });
});
