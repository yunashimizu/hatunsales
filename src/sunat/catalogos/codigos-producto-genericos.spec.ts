import {
  categoriasConGenerico,
  CODIGO_GENERICO_GENERAL,
  codigoGenericoDeCategoria,
  normalizarCategoria,
} from './codigos-producto-genericos';

describe('código de producto SUNAT genérico por categoría (S6)', () => {
  it.each([
    ['Pinturas y Barnices', '31210000'],
    ['PINTURA', '31210000'],
    ['Herramientas manuales', '27110000'],
    ['Herramientas eléctricas', '27112700'],
    ['Materiales eléctricos', '39120000'],
    ['Iluminación LED', '39100000'],
    ['Gasfitería', '40140000'],
    ['Tuberías y accesorios PVC', '40140000'],
    ['Cemento y agregados', '30110000'],
    ['Materiales de construcción', '30100000'],
    ['Seguridad industrial', '46180000'],
    ['Limpieza', '47130000'],
    ['Adhesivos y selladores', '31200000'],
    ['Ferretería', '31160000'],
    ['Tornillos y pernos', '31160000'],
  ])('«%s» → %s', (categoria, esperado) => {
    expect(codigoGenericoDeCategoria(categoria).codigo).toBe(esperado);
  });

  it('sin categoría o con una categoría desconocida sale el de ferretería en general', () => {
    for (const categoria of [undefined, null, '', '   ', 'Regalos y juguetes']) {
      expect(codigoGenericoDeCategoria(categoria)).toEqual(CODIGO_GENERICO_GENERAL);
    }
  });

  it('la clave empieza una palabra: «led» no coincide dentro de «pulido»', () => {
    expect(codigoGenericoDeCategoria('Pulido fino')).toEqual(CODIGO_GENERICO_GENERAL);
    expect(codigoGenericoDeCategoria('Foco led')).toMatchObject({ codigo: '39100000' });
  });

  it('normaliza tildes, mayúsculas y signos', () => {
    expect(normalizarCategoria('  ELÉCTRICOS / Iluminación ')).toBe('electricos iluminacion');
  });

  it('todos los códigos son de 8 dígitos y los más específicos van antes que los generales', () => {
    const reglas = categoriasConGenerico();
    for (const regla of reglas) expect(regla.generico.codigo).toMatch(/^\d{8}$/);
    expect(CODIGO_GENERICO_GENERAL.codigo).toMatch(/^\d{8}$/);
    const orden = (categoria: string) => reglas.findIndex((r) => r.generico.nombre === codigoGenericoDeCategoria(categoria).nombre);
    expect(orden('Herramientas eléctricas')).toBeLessThan(orden('Herramientas'));
  });
});
