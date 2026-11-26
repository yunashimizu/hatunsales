import { correlativoDeSku, formatearSku, patronSku, prefijoDeCategoria } from './codigo-sku';

describe('SKU sugerido (Fase 2.8)', () => {
  it('prefijo: tres letras sin tildes ni signos, en mayúsculas; GEN sin categoría; X si faltan letras', () => {
    expect(prefijoDeCategoria('Herramientas')).toBe('HER');
    expect(prefijoDeCategoria('  ñandú eléctrico')).toBe('NAN');
    expect(prefijoDeCategoria('Pvc')).toBe('PVC');
    expect(prefijoDeCategoria('1/2 "Tubos"')).toBe('TUB');
    expect(prefijoDeCategoria('Ok')).toBe('OKX');
    expect(prefijoDeCategoria('')).toBe('GEN');
    expect(prefijoDeCategoria(null)).toBe('GEN');
    expect(prefijoDeCategoria('123 !!')).toBe('GEN');
  });

  it('correlativo: reconoce HER-0007, HER7 y her-12; ignora otros formatos', () => {
    expect(correlativoDeSku('HER-0007', 'HER')).toBe(7);
    expect(correlativoDeSku(' her12 ', 'HER')).toBe(12);
    expect(correlativoDeSku('HERR-1', 'HER')).toBeNull();
    expect(correlativoDeSku('HER-1A', 'HER')).toBeNull();
    expect(correlativoDeSku('', 'HER')).toBeNull();
  });

  it('formato con 4 dígitos como mínimo; el patrón solo acepta prefijos de 3 letras', () => {
    expect(formatearSku('GEN', 1)).toBe('GEN-0001');
    expect(formatearSku('HER', 12345)).toBe('HER-12345');
    expect(() => patronSku("HE'R")).toThrow();
  });
});
