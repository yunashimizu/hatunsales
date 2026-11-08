import {
  calcularComprobante,
  desagregarIgv,
  redondear,
  TIPO_IGV_EXONERADO,
  TIPO_IGV_GRAVADO,
  TIPO_IGV_INAFECTO,
} from './calculo-fiscal';

describe('redondear', () => {
  it('redondea a 2 decimales con la media hacia arriba (con épsilon cuando el valor es pequeño: 0.005 → 0.01)', () => {
    expect(redondear(0.005)).toBe(0.01);
    expect(redondear(0.125)).toBe(0.13);
    expect(redondear(2.675)).toBe(2.68);
    expect(redondear(0.1 + 0.2)).toBe(0.3);
    expect(redondear(10.004)).toBe(10);
  });

  it('simétrico para negativos (notas de crédito en el reporte)', () => {
    expect(redondear(-0.125)).toBe(-0.13);
    expect(redondear(-2.675)).toBe(-2.68);
    expect(redondear(-0.004)).toBe(-0);
  });

  it('admite otra cantidad de decimales y devuelve 0 si no es un número finito', () => {
    expect(redondear(1.23456789, 6)).toBe(1.234568);
    expect(redondear(Number.NaN)).toBe(0);
    expect(redondear(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('desagregarIgv', () => {
  it('118 con IGV = 100 de base + 18 de IGV', () => {
    expect(desagregarIgv(118)).toEqual({ subtotal: 100, igv: 18 });
  });

  it('base e IGV siempre suman el total (sin céntimo perdido)', () => {
    for (const total of [0.01, 0.99, 9.99, 29.7, 59.9, 118.01, 1234.57, 99999.99]) {
      const { subtotal, igv } = desagregarIgv(total);
      expect(redondear(subtotal + igv)).toBe(total);
    }
  });

  it('el IGV se obtiene restando a la base, no multiplicándola (29.70 → 25.17 + 4.53)', () => {
    expect(desagregarIgv(29.7)).toEqual({ subtotal: 25.17, igv: 4.53 });
  });

  it('respeta otra tasa (10 %)', () => {
    expect(desagregarIgv(110, 10)).toEqual({ subtotal: 100, igv: 10 });
  });
});

describe('calcularComprobante', () => {
  it('una línea gravada: valor unitario sin IGV, precio con IGV y totales', () => {
    const r = calcularComprobante([{ cantidad: 2, precio_unitario: 59 }]);
    expect(r.lineas[0]).toMatchObject({ cantidad: 2, valor_unitario: 50, precio_unitario: 59, subtotal: 100, igv: 18, total: 118, tipo_de_igv: TIPO_IGV_GRAVADO });
    expect(r).toMatchObject({ total_gravada: 100, total_igv: 18, total: 118, total_descuento: 0, porcentaje_igv: 18 });
  });

  it('el descuento va sobre el total CON IGV y nunca deja la línea en negativo', () => {
    const r = calcularComprobante([{ cantidad: 1, precio_unitario: 118, descuento: 18 }]);
    expect(r.lineas[0]).toMatchObject({ descuento: 18, total: 100, subtotal: 84.75, igv: 15.25 });
    expect(r.total_descuento).toBe(18);

    const exceso = calcularComprobante([{ cantidad: 1, precio_unitario: 50, descuento: 80 }]);
    expect(exceso.lineas[0]).toMatchObject({ descuento: 50, total: 0, subtotal: 0, igv: 0 });
  });

  it('exonerado e inafecto no llevan IGV y van a su propio acumulado', () => {
    const r = calcularComprobante([
      { cantidad: 1, precio_unitario: 118 },
      { cantidad: 1, precio_unitario: 40, tipo_de_igv: TIPO_IGV_EXONERADO },
      { cantidad: 2, precio_unitario: 15, tipo_de_igv: TIPO_IGV_INAFECTO },
    ]);
    expect(r).toMatchObject({ total_gravada: 100, total_exonerada: 40, total_inafecta: 30, total_igv: 18, total: 188 });
  });

  it('un tipo de IGV desconocido se trata como gravado', () => {
    const r = calcularComprobante([{ cantidad: 1, precio_unitario: 118, tipo_de_igv: 77 }]);
    expect(r.lineas[0].tipo_de_igv).toBe(TIPO_IGV_GRAVADO);
    expect(r.total_igv).toBe(18);
  });

  it('el total del comprobante es la suma de los totales de línea y la base más el IGV no se aparta de él', () => {
    const entradas = Array.from({ length: 25 }, (_, i) => ({ cantidad: (i % 4) + 1, precio_unitario: 0.7 + i * 1.33 }));
    const r = calcularComprobante(entradas);
    const sumaLineas = redondear(r.lineas.reduce((s, l) => s + l.total, 0));
    expect(r.total).toBe(sumaLineas);
    // La tolerancia que SUNAT admite entre los totales es de 1 céntimo (reglas-totales).
    expect(Math.abs(redondear(r.total_gravada + r.total_exonerada + r.total_inafecta + r.total_igv) - r.total)).toBeLessThanOrEqual(0.01);
  });

  it('IGV en 10 % (régimen especial) y tasa inválida vuelve al 18 %', () => {
    expect(calcularComprobante([{ cantidad: 1, precio_unitario: 110 }], 10)).toMatchObject({ total_gravada: 100, total_igv: 10, porcentaje_igv: 10 });
    expect(calcularComprobante([{ cantidad: 1, precio_unitario: 118 }], -5).porcentaje_igv).toBe(18);
    expect(calcularComprobante([{ cantidad: 1, precio_unitario: 118 }], Number.NaN).porcentaje_igv).toBe(18);
  });

  it('sin líneas o con datos no numéricos devuelve ceros sin lanzar', () => {
    expect(calcularComprobante([])).toMatchObject({ total: 0, total_igv: 0, lineas: [] });
    expect(calcularComprobante(undefined as never).total).toBe(0);
    const r = calcularComprobante([{ cantidad: 'x' as never, precio_unitario: 10 }]);
    expect(r.lineas[0]).toMatchObject({ cantidad: 0, total: 0, valor_unitario: 0 });
  });

  it('el valor unitario conserva 6 decimales (SUNAT) aunque los totales van a 2', () => {
    const r = calcularComprobante([{ cantidad: 7, precio_unitario: 1 }]);
    expect(r.lineas[0]).toMatchObject({ subtotal: 5.93, igv: 1.07, total: 7, valor_unitario: 0.847143 });
  });
});
