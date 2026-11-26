import { columnasRastro, extrasFila, extrasLote, sufijo, SIN_COLUMNAS_RASTRO } from './rastro-movimiento';

const TODAS = { usuario: true, almacen: true, documento: true };

describe('rastro-movimiento (Fase 8.1): fragmentos del INSERT según las columnas de fase21', () => {
  it('sin columnas (fase21 sin correr) no agrega nada: el INSERT queda como antes', () => {
    const extras = extrasFila(SIN_COLUMNAS_RASTRO, { id_usuario: 4, tipo_documento: 'ajuste' }, 2, 7);
    expect(extras).toEqual({ columnas: [], expresiones: [], valores: [] });
    expect(sufijo(extras.columnas)).toBe('');
  });

  it('con todas: usuario, almacén y documento numerados desde el primer $ libre', () => {
    const extras = extrasFila(TODAS, { id_usuario: 4, tipo_documento: 'recepcion', id_documento: 77 }, 2, 7);
    expect(extras.columnas).toEqual(['id_usuario', 'id_almacen', 'tipo_documento', 'id_documento']);
    expect(extras.expresiones).toEqual(['$7::int', '$8::int', '$9::varchar', '$10::int']);
    expect(extras.valores).toEqual([4, 2, 'recepcion', 77]);
    expect(sufijo(extras.expresiones)).toBe(', $7::int, $8::int, $9::varchar, $10::int');
  });

  it('cada columna depende de su capacidad: solo almacén', () => {
    const extras = extrasFila({ usuario: false, almacen: true, documento: false }, { id_usuario: 4 }, 3, 7);
    expect(extras).toEqual({ columnas: ['id_almacen'], expresiones: ['$7::int'], valores: [3] });
  });

  it('sin usuario (pedido web, sistema) o con datos raros guarda NULL; un tipo desconocido no se guarda', () => {
    const extras = extrasFila(TODAS, { id_usuario: 0, tipo_documento: 'inventado' as any, id_documento: 5 }, null, 1);
    expect(extras.valores).toEqual([null, null, null, null]);
    expect(extrasFila(TODAS, undefined, undefined, 1).valores).toEqual([null, null, null, null]);
  });

  it('por lotes: el almacén sale de cada fila (expresión fija) y el resto son parámetros', () => {
    const extras = extrasLote(TODAS, { id_usuario: 9, tipo_documento: 'venta', id_documento: 50 }, 5, 'm.id_almacen');
    expect(extras.expresiones).toEqual(['$5::int', 'm.id_almacen', '$6::varchar', '$7::int']);
    expect(extras.valores).toEqual([9, 'venta', 50]);
  });

  it('columnasRastro nunca lanza: sin servicio o si el catálogo falla, sin columnas', async () => {
    expect(await columnasRastro(undefined)).toEqual(SIN_COLUMNAS_RASTRO);
    expect(await columnasRastro({ tiene: async () => { throw new Error('sin conexión'); } })).toEqual(SIN_COLUMNAS_RASTRO);
    expect(await columnasRastro({ tiene: async (c) => c !== 'movimientoDocumento' })).toEqual({ usuario: true, almacen: true, documento: false });
  });
});
