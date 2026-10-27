import { VentaRepository } from './venta.repository';

function crear() {
  const dataSource = { query: jest.fn() };
  return { repo: new VentaRepository(dataSource as never, {} as never), dataSource };
}

const fila = {
  id_producto: 7,
  nombre: 'CEMENTO SOL',
  sku: 'CEM-01',
  codigo_barras: '7501234567890',
  precio_venta: '10.00',
  descuento: '0',
  reglas_mayoristas: [],
  stock_disponible: '5',
};

describe('VentaRepository.buscarPorCodigoBarras', () => {
  it('compara el código recortado con ANY(variantes) y desempata por id ascendente', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([fila]);

    const producto = await repo.buscarPorCodigoBarras('7501234567890');

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain("btrim(COALESCE(p.codigo_barras, '')) = ANY($1)");
    expect(sql).toContain("LOWER(COALESCE(p.sku, '')) = LOWER($2)");
    expect(sql).toContain('p.id_producto ASC');
    expect(sql).toContain('COALESCE(p.estado, TRUE) = TRUE');
    expect(sql).toMatch(/LIMIT 1/);
    expect(params).toEqual([['7501234567890'], '7501234567890']);
    expect(producto).toMatchObject({ id_producto: 7, precio_final: 10 });
  });

  it('un UPC-A de 12 dígitos también busca la variante EAN-13 con 0 delante', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([]);

    await repo.buscarPorCodigoBarras('036000291452');

    expect(dataSource.query.mock.calls[0][1]).toEqual([['036000291452', '0036000291452'], '036000291452']);
  });

  it('con almacén, el id del almacén va primero y los parámetros del código se desplazan', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([]);

    await repo.buscarPorCodigoBarras('CEM-01', 3);

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('inv.id_almacen = $1');
    expect(sql).toContain("btrim(COALESCE(p.codigo_barras, '')) = ANY($2)");
    expect(sql).toContain("LOWER(COALESCE(p.sku, '')) = LOWER($3)");
    expect(params).toEqual([3, ['CEM-01'], 'CEM-01']);
  });

  it('sin coincidencias devuelve null y un código vacío no consulta', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([]);

    await expect(repo.buscarPorCodigoBarras('999')).resolves.toBeNull();
    await expect(repo.buscarPorCodigoBarras('   ')).resolves.toBeNull();
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });
});

describe('VentaRepository.buscarInactivoPorCodigo', () => {
  it('consulta solo inactivos con el mismo criterio y devuelve id y nombre', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([{ id_producto: '12', nombre: 'CLAVO' }]);

    const inactivo = await repo.buscarInactivoPorCodigo('036000291452');

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('COALESCE(p.estado, TRUE) = FALSE');
    expect(sql).toContain("btrim(COALESCE(p.codigo_barras, '')) = ANY($1)");
    expect(sql).toContain('p.id_producto ASC');
    expect(params).toEqual([['036000291452', '0036000291452'], '036000291452']);
    expect(inactivo).toEqual({ id_producto: 12, nombre: 'CLAVO' });
  });

  it('sin coincidencias devuelve null; vacío no consulta', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([]);

    await expect(repo.buscarInactivoPorCodigo('999')).resolves.toBeNull();
    await expect(repo.buscarInactivoPorCodigo('')).resolves.toBeNull();
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });
});
