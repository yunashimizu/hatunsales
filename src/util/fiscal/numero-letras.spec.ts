import { enteroALetras, montoEnLetras, numeroALetras } from './numero-letras';

describe('numeroALetras (leyenda 1000 del comprobante)', () => {
  it('importes redondos en soles con céntimos en cero', () => {
    expect(numeroALetras(0)).toBe('CERO CON 00/100 SOLES');
    expect(numeroALetras(1)).toBe('UNO CON 00/100 SOLES');
    expect(numeroALetras(118)).toBe('CIENTO DIECIOCHO CON 00/100 SOLES');
    expect(numeroALetras(100)).toBe('CIEN CON 00/100 SOLES');
  });

  it('céntimos con dos cifras, sin errores de coma flotante', () => {
    expect(numeroALetras(29.7)).toBe('VEINTINUEVE CON 70/100 SOLES');
    expect(numeroALetras(0.05)).toBe('CERO CON 05/100 SOLES');
    expect(numeroALetras(1.01)).toBe('UNO CON 01/100 SOLES');
    expect(numeroALetras(10.99)).toBe('DIEZ CON 99/100 SOLES');
    expect(numeroALetras(0.29)).toBe('CERO CON 29/100 SOLES');
  });

  it('decenas y veintis: VEINTE, VEINTIUNO, VEINTIDOS, TREINTA Y UNO', () => {
    expect(numeroALetras(20)).toBe('VEINTE CON 00/100 SOLES');
    expect(numeroALetras(21)).toBe('VEINTIUNO CON 00/100 SOLES');
    expect(numeroALetras(22)).toBe('VEINTIDOS CON 00/100 SOLES');
    expect(numeroALetras(31)).toBe('TREINTA Y UNO CON 00/100 SOLES');
    expect(numeroALetras(99)).toBe('NOVENTA Y NUEVE CON 00/100 SOLES');
  });

  it('miles, con el apócope delante de MIL (VEINTIUN MIL, no VEINTIUNO MIL)', () => {
    expect(numeroALetras(1000)).toBe('MIL CON 00/100 SOLES');
    expect(numeroALetras(1500.5)).toBe('MIL QUINIENTOS CON 50/100 SOLES');
    expect(numeroALetras(21000)).toBe('VEINTIUN MIL CON 00/100 SOLES');
    expect(numeroALetras(31000)).toBe('TREINTA Y UN MIL CON 00/100 SOLES');
    expect(numeroALetras(201000)).toBe('DOSCIENTOS UN MIL CON 00/100 SOLES');
    expect(numeroALetras(999999.99)).toBe('NOVECIENTOS NOVENTA Y NUEVE MIL NOVECIENTOS NOVENTA Y NUEVE CON 99/100 SOLES');
  });

  it('millones: UN MILLON en singular, MILLONES con apócope en plural', () => {
    expect(numeroALetras(1_000_000)).toBe('UN MILLON CON 00/100 SOLES');
    expect(numeroALetras(2_000_000)).toBe('DOS MILLONES CON 00/100 SOLES');
    expect(numeroALetras(21_000_000)).toBe('VEINTIUN MILLONES CON 00/100 SOLES');
    expect(numeroALetras(1_250_300.25)).toBe('UN MILLON DOSCIENTOS CINCUENTA MIL TRESCIENTOS CON 25/100 SOLES');
  });

  it('dólares, euros y libras; una moneda desconocida cae en soles', () => {
    expect(numeroALetras(118, 2)).toBe('CIENTO DIECIOCHO CON 00/100 DOLARES AMERICANOS');
    expect(numeroALetras(1234.56, 2)).toBe('MIL DOSCIENTOS TREINTA Y CUATRO CON 56/100 DOLARES AMERICANOS');
    expect(numeroALetras(5, 3)).toBe('CINCO CON 00/100 EUROS');
    expect(numeroALetras(5, 4)).toBe('CINCO CON 00/100 LIBRAS ESTERLINAS');
    expect(numeroALetras(5, 99)).toBe('CINCO CON 00/100 SOLES');
  });

  it('el signo se ignora (la nota de crédito imprime el importe en positivo) y lo no numérico es cero', () => {
    expect(numeroALetras(-50)).toBe('CINCUENTA CON 00/100 SOLES');
    expect(numeroALetras(Number.NaN)).toBe('CERO CON 00/100 SOLES');
    expect(numeroALetras(undefined as never)).toBe('CERO CON 00/100 SOLES');
  });

  it('un redondeo de céntimos que llega a 100 sube el entero', () => {
    expect(numeroALetras(9.999)).toBe('DIEZ CON 00/100 SOLES');
  });
});

describe('montoEnLetras (proformas y cotizaciones)', () => {
  it('usa «Y» en lugar de «CON»', () => {
    expect(montoEnLetras(144)).toBe('CIENTO CUARENTA Y CUATRO Y 00/100 SOLES');
    expect(montoEnLetras(144.5, 2)).toBe('CIENTO CUARENTA Y CUATRO Y 50/100 DOLARES AMERICANOS');
  });
});

describe('enteroALetras', () => {
  it('cubre cero, centenas exactas y miles redondos', () => {
    expect(enteroALetras(0)).toBe('CERO');
    expect(enteroALetras(500)).toBe('QUINIENTOS');
    expect(enteroALetras(101)).toBe('CIENTO UNO');
    expect(enteroALetras(100_000)).toBe('CIEN MIL');
    expect(enteroALetras(1_000_001)).toBe('UN MILLON UNO');
  });
});
