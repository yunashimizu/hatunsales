import { VentaRepository } from './venta.repository';

/**
 * El repositorio hace dos consultas: la detección de `productos.destacado` (information_schema,
 * una vez) y el catálogo. `conColumna` decide lo que contesta la detección.
 */
function crear(conColumna = true) {
  const dataSource = { query: jest.fn() };
  const filasCatalogo = { actual: [] as unknown[] };
  dataSource.query.mockImplementation(async (sql: string) =>
    String(sql).includes('information_schema.columns') ? (conColumna ? [{ '?column?': 1 }] : []) : filasCatalogo.actual,
  );
  const responder = (filas: unknown[]) => {
    filasCatalogo.actual = filas;
  };
  const consultasCatalogo = () =>
    dataSource.query.mock.calls.filter(([sql]) => !String(sql).includes('information_schema.columns'));
  return { repo: new VentaRepository(dataSource as never, {} as never), dataSource, responder, consultasCatalogo };
}

const base = {
  nombre: 'CEMENTO SOL',
  sku: 'CEM-01',
  codigo_barras: '7501234567890',
  unidad_medida: 'BLS',
  precio_venta: '10.00',
  descuento: '0',
  reglas_mayoristas: [],
  stock_disponible: '5',
  imagen_url: '',
};

describe('VentaRepository.catalogoProductos: categoría y destacado', () => {
  it('trae la categoría y el destacado con UNA sola consulta (LEFT JOIN, sin N+1)', async () => {
    const { repo, responder, consultasCatalogo } = crear();
    responder([
      { ...base, id_producto: 1, categoria: 'Cementos', destacado: true },
      { ...base, id_producto: 2, categoria: 'Clavos', destacado: false },
    ]);

    const r = await repo.catalogoProductos(100);

    expect(consultasCatalogo()).toHaveLength(1);
    const sql = String(consultasCatalogo()[0][0]);
    expect(sql).toContain('LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria');
    expect(sql).toContain('cat.nombre');
    expect(r[0]).toMatchObject({ id_producto: 1, categoria: 'Cementos', destacado: true });
    expect(r[1]).toMatchObject({ id_producto: 2, categoria: 'Clavos', destacado: false });
  });

  it('un producto sin categoría devuelve categoria null', async () => {
    const { repo, responder } = crear();
    responder([{ ...base, id_producto: 3, categoria: null, destacado: false }]);

    const [p] = await repo.catalogoProductos();

    expect(p.categoria).toBeNull();
  });

  it('destacado siempre sale booleano (null o ausente es false)', async () => {
    const { repo, responder } = crear();
    responder([
      { ...base, id_producto: 4, categoria: 'X', destacado: null },
      { ...base, id_producto: 5, categoria: 'X' },
      { ...base, id_producto: 6, categoria: 'X', destacado: true },
    ]);

    const r = await repo.catalogoProductos();

    expect(r.map((p) => p.destacado)).toEqual([false, false, true]);
    r.forEach((p) => expect(typeof p.destacado).toBe('boolean'));
  });

  it('conserva los campos de siempre (precio_final, stock, almacén en los parámetros)', async () => {
    const { repo, responder, consultasCatalogo } = crear();
    responder([{ ...base, id_producto: 7, categoria: null, destacado: false, descuento: '1.5' }]);

    const [p] = await repo.catalogoProductos(50, 3);

    expect(p).toMatchObject({ id_producto: 7, precio_venta: 10, precio_final: 8.5, stock_disponible: 5 });
    expect(consultasCatalogo()[0][1]).toEqual([3, 50]);
  });

  it('con la columna productos.destacado lee p.destacado directo, sin serializar la fila (to_jsonb)', async () => {
    const { repo, responder, consultasCatalogo } = crear(true);
    responder([{ ...base, id_producto: 8, categoria: null, destacado: true }]);

    const [p] = await repo.catalogoProductos();

    const sql = String(consultasCatalogo()[0][0]);
    expect(sql).toContain('COALESCE(p.destacado, false) AS destacado');
    expect(sql).not.toContain('to_jsonb');
    expect(p.destacado).toBe(true);
  });

  it('sin la columna (instalación antigua) devuelve false y no menciona p.destacado', async () => {
    const { repo, responder, consultasCatalogo } = crear(false);
    responder([{ ...base, id_producto: 9, categoria: null, destacado: false }]);

    const [p] = await repo.catalogoProductos();

    const sql = String(consultasCatalogo()[0][0]);
    expect(sql).toContain('false AS destacado');
    expect(sql).not.toContain('p.destacado');
    expect(sql).not.toContain('to_jsonb');
    expect(p.destacado).toBe(false);
  });

  it('la detección de la columna se hace una sola vez cuando existe', async () => {
    const { repo, dataSource, responder } = crear(true);
    responder([]);

    await repo.catalogoProductos();
    await repo.catalogoProductos();

    const deteccion = dataSource.query.mock.calls.filter(([sql]) => String(sql).includes('information_schema.columns'));
    expect(deteccion).toHaveLength(1);
  });
});
