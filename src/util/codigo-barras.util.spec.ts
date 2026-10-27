import { digitoVerificadorEan13, ean13Interno, esEan13Valido, variantesCodigo } from './codigo-barras.util';

describe('variantesCodigo', () => {
  it('UPC-A de 12 dígitos: él mismo y con 0 delante', () => {
    expect(variantesCodigo('036000291452')).toEqual(['036000291452', '0036000291452']);
  });

  it('EAN-13 con 0 inicial: él mismo y sin el 0', () => {
    expect(variantesCodigo('0036000291452')).toEqual(['0036000291452', '036000291452']);
  });

  it('EAN-13 sin 0 inicial: solo él mismo', () => {
    expect(variantesCodigo('7501234567890')).toEqual(['7501234567890']);
  });

  it('EAN-8, Code 128 y SKU: solo ellos mismos', () => {
    expect(variantesCodigo('12345670')).toEqual(['12345670']);
    expect(variantesCodigo('AB/12')).toEqual(['AB/12']);
    expect(variantesCodigo('CEM-01')).toEqual(['CEM-01']);
  });

  it('11 o 14 dígitos no se tocan', () => {
    expect(variantesCodigo('12345678901')).toEqual(['12345678901']);
    expect(variantesCodigo('01234567890123')).toEqual(['01234567890123']);
  });

  it('recorta espacios y un código vacío no tiene variantes', () => {
    expect(variantesCodigo('  036000291452 ')).toEqual(['036000291452', '0036000291452']);
    expect(variantesCodigo('   ')).toEqual([]);
    expect(variantesCodigo(undefined as unknown as string)).toEqual([]);
  });
});

describe('digitoVerificadorEan13', () => {
  it.each([
    ['400638133393', 1],
    ['750123456789', 3],
    ['590123412345', 7],
  ])('%s → %i', (doce, esperado) => {
    expect(digitoVerificadorEan13(doce)).toBe(esperado);
  });

  it('rechaza lo que no sean 12 dígitos', () => {
    expect(() => digitoVerificadorEan13('12345')).toThrow();
    expect(() => digitoVerificadorEan13('40063813339a')).toThrow();
  });
});

describe('esEan13Valido', () => {
  it.each(['4006381333931', '7501234567893', '5901234123457'])('%s es válido', (codigo) => {
    expect(esEan13Valido(codigo)).toBe(true);
  });

  it('con el último dígito cambiado es inválido', () => {
    expect(esEan13Valido('4006381333932')).toBe(false);
    expect(esEan13Valido('7501234567891')).toBe(false);
    // 7501234567890 (el ejemplo clásico de los docs) tiene mal el verificador: el correcto es 3.
    expect(esEan13Valido('7501234567890')).toBe(false);
  });

  it('largo distinto o no numérico es inválido', () => {
    expect(esEan13Valido('400638133393')).toBe(false);
    expect(esEan13Valido('40063813339311')).toBe(false);
    expect(esEan13Valido('40063813339a1')).toBe(false);
    expect(esEan13Valido('')).toBe(false);
  });
});

describe('ean13Interno', () => {
  it('arma «2» + 11 dígitos con ceros + verificador, y es válido', () => {
    expect(ean13Interno(1)).toBe('2000000000015');
    const codigo = ean13Interno(123456);
    expect(codigo).toHaveLength(13);
    expect(codigo.startsWith('2000001234')).toBe(true);
    expect(esEan13Valido(codigo)).toBe(true);
  });

  it('el máximo que cabe (11 dígitos) sigue siendo válido', () => {
    const codigo = ean13Interno(99_999_999_999);
    expect(codigo.slice(0, 12)).toBe('299999999999');
    expect(esEan13Valido(codigo)).toBe(true);
  });

  it('lanza si no cabe en 11 dígitos, es negativo o no es entero', () => {
    expect(() => ean13Interno(100_000_000_000)).toThrow('no cabe en 11 dígitos');
    expect(() => ean13Interno(-1)).toThrow();
    expect(() => ean13Interno(1.5)).toThrow();
    expect(() => ean13Interno(Number.NaN)).toThrow();
  });
});
