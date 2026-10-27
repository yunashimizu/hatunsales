import { ALIAS_UNIDADES, UNIDADES_CATALOGO_03, esUnidadCatalogo03, normalizarUnidad } from './sunat.catalogos';

describe('normalizarUnidad', () => {
  it.each([
    ['varilla', 'RD'],
    ['1/4 gl', 'QT'],
    ['metro lineal', 'MTR'],
    ['mtl', 'MTR'],
    ['ml', 'MLT'],
    ['Galón', 'GLL'],
    ['UND', 'NIU'],
    ['kg', 'KGM'],
    ['Plancha', 'ST'],
    ['SACOS', 'SA'],
    ['horas', 'HUR'],
    ['día', 'DAY'],
    ['pz', 'C62'],
    ['Cuarto de galón', 'QT'],
    ['millar', 'MLL'],
    ['Millares', 'MLL'],
  ])('«%s» → %s sin advertencia', (entrada, codigo) => {
    expect(normalizarUnidad(entrada)).toEqual({ codigo });
  });

  it('MIL sigue aceptado como código oficial (oculto en el selector)', () => {
    expect(normalizarUnidad('MIL')).toEqual({ codigo: 'MIL' });
    expect(normalizarUnidad('MLL')).toEqual({ codigo: 'MLL' });
  });

  it('«m.l.» pierde los puntos y queda ML (mililitro), nunca metro lineal', () => {
    expect(normalizarUnidad('m.l.')).toEqual({ codigo: 'MLT' });
  });

  it('CJ es el cono del catálogo, sin alias de caja', () => {
    expect(normalizarUnidad('CJ')).toEqual({ codigo: 'CJ' });
    expect(ALIAS_UNIDADES['CJ']).toBeUndefined();
    expect(normalizarUnidad('caja')).toEqual({ codigo: 'BX' });
  });

  it('los códigos oficiales pasan tal cual', () => {
    for (const codigo of ['NIU', 'SA', 'RD', 'BR', 'SR', 'BD', 'CO', 'QT', 'PT', 'HUR', 'DAY']) {
      expect(normalizarUnidad(codigo)).toEqual({ codigo });
    }
  });

  it('una unidad desconocida cae a NIU con advertencia', () => {
    const r = normalizarUnidad('XYZ');
    expect(r.codigo).toBe('NIU');
    expect(r.advertencia).toContain('XYZ');
  });

  it.each([[''], ['   '], [null], [undefined]])('vacío (%p) → NIU con advertencia', (entrada) => {
    const r = normalizarUnidad(entrada as any);
    expect(r.codigo).toBe('NIU');
    expect(r.advertencia).toBeDefined();
  });
});

describe('ALIAS_UNIDADES', () => {
  it('todo alias apunta a un código del catálogo 03', () => {
    const rotos = Object.entries(ALIAS_UNIDADES).filter(([, codigo]) => !esUnidadCatalogo03(codigo));
    expect(rotos).toEqual([]);
  });

  it('el catálogo incluye los 10 códigos nuevos de ferretería', () => {
    for (const codigo of ['SA', 'RD', 'BR', 'SR', 'BD', 'CO', 'QT', 'PT', 'HUR', 'DAY']) {
      expect(UNIDADES_CATALOGO_03[codigo]).toBeDefined();
    }
    expect(Object.keys(UNIDADES_CATALOGO_03)).toHaveLength(76);
  });
});
