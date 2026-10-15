import { DecimalExacto, Dinero, formatearDecimal, redondear } from './decimal';
import { construirLineaCpe, lineaCpeDesdeValorSinIgv, totalesCpeDesdeLineas } from './linea-cpe';
import { lineasDesdeVenta } from './pruebas/documentos-prueba-spec';

describe('DecimalExacto y Dinero', () => {
  it('redondea medio hacia afuera sobre el valor decimal (no sobre el binario)', () => {
    expect(redondear(1.005, 2)).toBe(1.01);
    expect(redondear(-1.005, 2)).toBe(-1.01);
    expect(redondear(2.675, 2)).toBe(2.68);
    expect((1.005).toFixed(2)).toBe('1.00'); // lo que evita el núcleo
  });

  it('suma y resta sin errores de coma flotante', () => {
    expect(Dinero.suma([0.1, 0.2]).toString()).toBe('0.30');
    expect(Dinero.de(8.47).mas(1.53).toString()).toBe('10.00');
    expect(Dinero.de('118').menos(100).toString()).toBe('18.00');
  });

  it('divide con la precisión pedida y formatea sin ceros sobrantes', () => {
    expect(DecimalExacto.de(10).por(100).entre(118, 6).toString()).toBe('8.474576');
    expect(formatearDecimal(11.8, 10, 2)).toBe('11.80');
    expect(formatearDecimal(2, 10)).toBe('2');
    expect(formatearDecimal('1e-7', 10)).toBe('0.0000001');
  });

  it('rechaza valores no numéricos', () => {
    expect(() => DecimalExacto.de(Number.NaN)).toThrow('Valor numérico inválido');
    expect(() => DecimalExacto.de('abc')).toThrow('Valor numérico inválido');
    expect(() => DecimalExacto.de(1).entre(0, 2)).toThrow('División entre cero');
  });
});

describe('construirLineaCpe (líneas ya calculadas por el negocio)', () => {
  it('precio 10.00 con IGV → valor unitario 8.474576, valor de venta 8.47, IGV 1.53, total 10.00', () => {
    const linea = construirLineaCpe(
      { cantidad: 1, precioUnitario: 10, subtotal: 8.47, igv: 1.53, total: 10, afectacion: '10', descuento: 0 },
      { unidad: 'NIU', descripcion: 'CEMENTO' },
      18,
    );
    expect(linea).toMatchObject({
      valorUnitario: 8.474576,
      valorVenta: 8.47,
      igv: 1.53,
      total: 10,
      precioVentaUnitario: 10,
      descuentoBase: 0,
    });
  });

  it('no inventa un descuento por el redondeo de cantidad × valor unitario cuando el negocio no registró descuento', () => {
    const { lineas } = lineasDesdeVenta([{ descripcion: 'CABLE', cantidad: 2.5, precio: 3.33, tipoIgv: 1 }]);
    expect(lineas[0].descuentoBase).toBe(0);
    expect(lineas[0].valorVenta + lineas[0].igv).toBeCloseTo(lineas[0].total, 10);
  });

  it('deriva el descuento sin IGV que afecta la base cuando el negocio lo registró', () => {
    // 2 × 59.00 = 118.00, descuento 11.80 con IGV → total 106.20, base 90.00, IGV 16.20
    const { lineas, totales } = lineasDesdeVenta([{ descripcion: 'TALADRO', cantidad: 2, precio: 59, descuento: 11.8 }]);
    expect(lineas[0]).toMatchObject({ valorUnitario: 50, valorVenta: 90, igv: 16.2, total: 106.2, descuentoBase: 10, precioVentaUnitario: 53.1 });
    expect(totales).toMatchObject({ gravada: 90, igv: 16.2, total: 106.2, descuentos: 10 });
  });

  it('exonerado e inafecto: el valor unitario es el precio y el IGV es cero', () => {
    const { lineas, totales } = lineasDesdeVenta([
      { descripcion: 'LIBRO', cantidad: 3, precio: 20, tipoIgv: 8 },
      { descripcion: 'SERVICIO INAFECTO', cantidad: 1, precio: 15.5, tipoIgv: 9, unidad: 'ZZ' },
    ]);
    expect(lineas.map((l) => [l.afectacion, l.valorUnitario, l.valorVenta, l.igv])).toEqual([
      ['20', 20, 60, 0],
      ['30', 15.5, 15.5, 0],
    ]);
    expect(totales).toMatchObject({ gravada: 0, exonerada: 60, inafecta: 15.5, igv: 0, total: 75.5 });
  });

  it('precio de venta unitario con hasta 10 decimales (total / cantidad)', () => {
    const { lineas } = lineasDesdeVenta([{ descripcion: 'TORNILLO', cantidad: 3, precio: 0.1, descuento: 0.01 }]);
    // total 0.29 / 3 = 0.0966666667
    expect(lineas[0].precioVentaUnitario).toBe(0.0966666667);
  });

  it('totalesCpeDesdeLineas suma al céntimo por afectación', () => {
    const { lineas } = lineasDesdeVenta([
      { descripcion: 'A', cantidad: 1, precio: 10 },
      { descripcion: 'B', cantidad: 3, precio: 0.1 },
      { descripcion: 'C', cantidad: 1, precio: 5, tipoIgv: 8 },
    ]);
    const totales = totalesCpeDesdeLineas(lineas);
    expect(totales.total).toBe(15.3);
    expect(Dinero.suma([totales.gravada, totales.exonerada, totales.inafecta, totales.igv]).aNumero()).toBe(15.3);
  });
});

describe('lineaCpeDesdeValorSinIgv (adaptadores BETA heredados)', () => {
  it('calcula el IGV sobre la base como antes: 2 × 10.00 sin IGV → base 20.00, IGV 3.60, P/U 11.80', () => {
    const linea = lineaCpeDesdeValorSinIgv({ cantidad: 2, valorUnitario: 10, afectacion: '10' }, { unidad: 'NIU', descripcion: 'X' }, 18);
    expect(linea).toMatchObject({ valorVenta: 20, igv: 3.6, total: 23.6, precioVentaUnitario: 11.8, descuentoBase: 0 });
  });

  it('el descuento nunca deja la línea en negativo', () => {
    const linea = lineaCpeDesdeValorSinIgv({ cantidad: 1, valorUnitario: 5, descuentoBase: 9, afectacion: '20' }, { unidad: 'NIU', descripcion: 'X' }, 18);
    expect(linea.valorVenta).toBe(0);
    expect(linea.descuentoBase).toBe(5);
  });
});
