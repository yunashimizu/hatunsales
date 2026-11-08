import { ProductoRepository } from './producto.repository';

function crear(resultado: unknown = null) {
  const qb: any = {};
  for (const m of ['where', 'orWhere', 'orderBy', 'addOrderBy']) qb[m] = jest.fn(() => qb);
  qb.getOne = jest.fn().mockResolvedValue(resultado);
  const productoRepo = { createQueryBuilder: jest.fn(() => qb) };
  return { repo: new ProductoRepository(productoRepo as never), productoRepo, qb };
}

describe('ProductoRepository.buscarPorCodigoBarras', () => {
  // Sin COALESCE en el WHERE para que valgan los índices (btrim(codigo_barras) y lower(sku)).
  it('compara con btrim, cae a SKU sin distinguir mayúsculas y no filtra por estado', async () => {
    const producto = { id_producto: 4 };
    const { repo, productoRepo, qb } = crear(producto);

    await expect(repo.buscarPorCodigoBarras('  CEM-01\r\n')).resolves.toBe(producto);

    expect(productoRepo.createQueryBuilder).toHaveBeenCalledWith('p');
    expect(qb.where).toHaveBeenCalledWith('btrim(p.codigo_barras) = :codigo', { codigo: 'CEM-01' });
    expect(qb.orWhere).toHaveBeenCalledWith('LOWER(p.sku) = LOWER(:codigo)', { codigo: 'CEM-01' });
    const todo = JSON.stringify([...qb.where.mock.calls, ...qb.orWhere.mock.calls]);
    expect(todo).not.toContain('estado');
  });

  // En el orden sí va el COALESCE: `NULL = :codigo` daría NULL y DESC lo pondría primero.
  it('desempata por barras primero y luego por id ascendente', async () => {
    const { repo, qb } = crear();

    await repo.buscarPorCodigoBarras('7501234567890');

    expect(qb.orderBy).toHaveBeenCalledWith("(btrim(COALESCE(p.codigo_barras, '')) = :codigo)", 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('p.id_producto', 'ASC');
  });

  it('un código vacío no consulta la base', async () => {
    const { repo, productoRepo } = crear();

    await expect(repo.buscarPorCodigoBarras('   ')).resolves.toBeNull();
    expect(productoRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('ProductoRepository.siguienteCodigoInterno', () => {
  function conQuery(query: jest.Mock) {
    return new ProductoRepository({ query } as never);
  }

  it('lee nextval de la secuencia de códigos internos y devuelve un número', async () => {
    const query = jest.fn().mockResolvedValue([{ n: '15' }]);
    await expect(conQuery(query).siguienteCodigoInterno()).resolves.toBe(15);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("nextval('productos_codigo_interno_seq')");
  });

  it('deja subir el error 42P01 de Postgres para que el negocio lo traduzca', async () => {
    const falla = { code: '42P01' };
    await expect(conQuery(jest.fn().mockRejectedValue(falla)).siguienteCodigoInterno()).rejects.toBe(falla);
  });

  it('una respuesta sin número válido lanza', async () => {
    await expect(conQuery(jest.fn().mockResolvedValue([{ n: null }])).siguienteCodigoInterno()).rejects.toThrow();
  });
});

describe('ProductoRepository.asignarCodigoSunat', () => {
  it('lee los ids del par [filas, cantidad] que entrega el driver de PostgreSQL en UPDATE ... RETURNING', async () => {
    const productoRepo = { query: jest.fn().mockResolvedValue([[{ id_producto: 1 }, { id_producto: 3 }], 2]) };
    const repo = new ProductoRepository(productoRepo as never);

    await expect(repo.asignarCodigoSunat([1, 3, 99], '72153600')).resolves.toEqual([1, 3]);
    expect(productoRepo.query).toHaveBeenCalledWith(expect.stringContaining('RETURNING id_producto'), [[1, 3, 99], '72153600']);
  });

  it('también acepta una lista simple de filas y no consulta con una lista vacía', async () => {
    const productoRepo = { query: jest.fn().mockResolvedValue([{ id_producto: 5 }]) };
    const repo = new ProductoRepository(productoRepo as never);

    await expect(repo.asignarCodigoSunat([5], '72153600')).resolves.toEqual([5]);
    await expect(repo.asignarCodigoSunat([], '72153600')).resolves.toEqual([]);
    expect(productoRepo.query).toHaveBeenCalledTimes(1);
  });
});

describe('ProductoRepository.buscarChoquesDeCodigos', () => {
  it('una sola consulta por índice: barras tal cual y SKU en minúsculas', async () => {
    const fila = { id_producto: 3, nombre: 'CEMENTO', codigo_barras: '7501', sku: 'CEM-01' };
    const productoRepo = { query: jest.fn().mockResolvedValue([fila]) };
    const repo = new ProductoRepository(productoRepo as never);

    await expect(repo.buscarChoquesDeCodigos(['7501', 'CEM-01'])).resolves.toEqual([fila]);
    expect(productoRepo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = productoRepo.query.mock.calls[0];
    // El predicado del índice parcial uq_productos_codigo_barras y la expresión de idx_productos_sku_lower.
    expect(sql).toContain("btrim(p.codigo_barras) <> ''");
    expect(sql).toContain('btrim(p.codigo_barras) = ANY($1::text[])');
    expect(sql).toContain('lower(p.sku) = ANY($2::text[])');
    expect(sql).not.toContain('COALESCE');
    expect(params).toEqual([['7501', 'CEM-01'], ['7501', 'cem-01']]);
  });

  it('sin códigos (vacíos o solo espacios) no consulta', async () => {
    const productoRepo = { query: jest.fn() };
    const repo = new ProductoRepository(productoRepo as never);

    await expect(repo.buscarChoquesDeCodigos([])).resolves.toEqual([]);
    await expect(repo.buscarChoquesDeCodigos(['', '   '])).resolves.toEqual([]);
    expect(productoRepo.query).not.toHaveBeenCalled();
  });
});

describe('ProductoRepository.actualizarSiExiste', () => {
  it('true si el UPDATE afectó una fila y false si no existía, sin leer después', async () => {
    const productoRepo = { update: jest.fn().mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 }), findOne: jest.fn() };
    const repo = new ProductoRepository(productoRepo as never);

    await expect(repo.actualizarSiExiste(7, { nombre: 'X' })).resolves.toBe(true);
    await expect(repo.actualizarSiExiste(99, { nombre: 'X' })).resolves.toBe(false);
    expect(productoRepo.update).toHaveBeenCalledWith(7, { nombre: 'X' });
    expect(productoRepo.findOne).not.toHaveBeenCalled();
  });
});
