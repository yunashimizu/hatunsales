import { VentaRepository } from './venta.repository';

function crear() {
  const dataSource = { query: jest.fn() };
  return { repo: new VentaRepository(dataSource as never, {} as never), dataSource };
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
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([
      { ...base, id_producto: 1, categoria: 'Cementos', destacado: true },
      { ...base, id_producto: 2, categoria: 'Clavos', destacado: false },
    ]);

    const r = await repo.catalogoProductos(100);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const sql = String(dataSource.query.mock.calls[0][0]);
    expect(sql).toContain('LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria');
    expect(sql).toContain('cat.nombre');
    expect(sql).toContain("to_jsonb(p) ->> 'destacado'");
    expect(r[0]).toMatchObject({ id_producto: 1, categoria: 'Cementos', destacado: true });
    expect(r[1]).toMatchObject({ id_producto: 2, categoria: 'Clavos', destacado: false });
  });

  it('un producto sin categoría devuelve categoria null', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([{ ...base, id_producto: 3, categoria: null, destacado: false }]);

    const [p] = await repo.catalogoProductos();

    expect(p.categoria).toBeNull();
  });

  it('destacado siempre sale booleano (null o ausente es false)', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([
      { ...base, id_producto: 4, categoria: 'X', destacado: null },
      { ...base, id_producto: 5, categoria: 'X' },
      { ...base, id_producto: 6, categoria: 'X', destacado: true },
    ]);

    const r = await repo.catalogoProductos();

    expect(r.map((p) => p.destacado)).toEqual([false, false, true]);
    r.forEach((p) => expect(typeof p.destacado).toBe('boolean'));
  });

  it('conserva los campos de siempre (precio_final, stock, almacén en los parámetros)', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([{ ...base, id_producto: 7, categoria: null, destacado: false, descuento: '1.5' }]);

    const [p] = await repo.catalogoProductos(50, 3);

    expect(p).toMatchObject({ id_producto: 7, precio_venta: 10, precio_final: 8.5, stock_disponible: 5 });
    expect(dataSource.query.mock.calls[0][1]).toEqual([3, 50]);
  });
});
