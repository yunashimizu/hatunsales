import { ConflictException } from '@nestjs/common';
import { InventarioBussnies } from '../../bussnies/Bussnies/inventario.bussnies';
import { InventarioRepository } from './inventario.repository';

/**
 * GET /inventario/detallado (pantalla Inventario y ficha de producto): el conteo no
 * necesita la imagen ni los catálogos, y la imagen se busca solo para las filas de la
 * página. Conteo y filas van en paralelo.
 */
function armar() {
  const pendientes: Array<{ sql: string; params: any[]; resolver: (v: any) => void }> = [];
  const query = jest.fn(
    (sql: string, params: any[] = []) =>
      new Promise((resolver) => {
        pendientes.push({ sql, params, resolver });
      }),
  );
  const repo = new InventarioRepository({} as any, { query } as any);
  return { repo, query, pendientes };
}

const fila = {
  id_inventario: 4,
  id_producto: 9,
  producto: 'Clavo 2"',
  sku: 'CLA-2',
  codigo_barras: '',
  unidad_medida: 'NIU',
  categoria: 'Clavos',
  id_almacen: 2,
  almacen: 'Principal',
  sucursal: 'Lurín',
  stock: '3',
  stock_minimo: '5',
  precio_compra: '0.10',
  precio_venta: '0.20',
  alerta: true,
  imagen_url: '/archivos/7',
};

describe('InventarioRepository.listarDetallado', () => {
  it('lanza conteo y filas a la vez; el conteo no lleva el LATERAL ni joins de catálogo', async () => {
    const { repo, query, pendientes } = armar();

    const promesa = repo.listarDetallado({ texto: 'clavo', id_almacen: 2, id_categoria: 3, pagina: 2, por_pagina: 20 });
    await Promise.resolve();

    // Las dos consultas salieron antes de que respondiera ninguna.
    expect(query).toHaveBeenCalledTimes(2);
    const conteo = pendientes.find((p) => p.sql.includes('COUNT(*)'))!;
    const filas = pendientes.find((p) => !p.sql.includes('COUNT(*)'))!;
    expect(conteo.sql).not.toMatch(/LATERAL/);
    expect(conteo.sql).not.toMatch(/almacenes|sucursales|categorias/);
    expect(conteo.params).toEqual(['%clavo%', 2, 3]);

    conteo.resolver([{ total: 41 }]);
    filas.resolver([fila]);
    const resultado = await promesa;

    expect(resultado.total).toBe(41);
    expect(resultado.pagina).toBe(2);
    expect(resultado.datos[0]).toMatchObject({
      id_inventario: 4,
      stock: 3,
      stock_minimo: 5,
      estado: 'bajo',
      imagen_url: '/archivos/7',
    });
  });

  it('corta la página antes de buscar la imagen y repite el mismo orden afuera', async () => {
    const { repo, pendientes } = armar();

    const promesa = repo.listarDetallado({ id_producto: 9, por_pagina: 1 });
    await Promise.resolve();
    const filas = pendientes.find((p) => !p.sql.includes('COUNT(*)'))!;

    expect(filas.sql.indexOf('LIMIT $2 OFFSET $3')).toBeGreaterThan(-1);
    expect(filas.sql.indexOf('LIMIT $2 OFFSET $3')).toBeLessThan(filas.sql.indexOf('LEFT JOIN LATERAL'));
    expect(filas.sql).toMatch(/WHERE pi\.id_producto = b\.id_producto/);
    expect(filas.sql).toMatch(/ORDER BY alerta DESC, p\.nombre ASC, i\.id_inventario ASC/);
    expect(filas.sql).toMatch(/ORDER BY b\.alerta DESC, b\.producto ASC, b\.id_inventario ASC\s*$/);
    expect(filas.params).toEqual([9, 1, 0]);

    for (const p of pendientes) p.resolver(p.sql.includes('COUNT(*)') ? [{ total: 1 }] : [fila]);
    await promesa;
  });
});

/**
 * Ajuste con `stockEsperado` (edición de producto con stock, A4): si el stock real, ya bloqueado
 * con FOR UPDATE, no es el que vio la ficha, no se escribe nada (ni UPDATE ni kardex).
 */
describe('InventarioRepository.ajustar · stock esperado', () => {
  function conManager(stockReal: number | null) {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('FOR UPDATE')) return stockReal === null ? [] : [{ id_inventario: 4, stock: String(stockReal) }];
      if (sql.includes('FROM almacenes')) return [{ id_sucursal: 1 }];
      return [];
    });
    const repo = new InventarioRepository({} as any, {} as any);
    return { repo, manager: { query } as any, query };
  }
  const escrituras = (query: jest.Mock) =>
    query.mock.calls.map((c) => String(c[0])).filter((sql) => /^\s*(UPDATE|INSERT)/.test(sql));

  it('stockEsperado distinto del real → STOCK_DESACTUALIZADO:<actual> sin UPDATE ni kardex', async () => {
    const { repo, manager, query } = conManager(8);
    await expect(repo.ajustar(9, 2, 2, 'Corrección de registro', manager, 10)).rejects.toThrow('STOCK_DESACTUALIZADO:8');
    expect(query).toHaveBeenCalledTimes(1);
    expect(escrituras(query)).toEqual([]);
  });

  it('sin fila en el almacén el stock real es 0', async () => {
    const { repo, manager, query } = conManager(null);
    await expect(repo.ajustar(9, 2, 5, 'x', manager, 3)).rejects.toThrow('STOCK_DESACTUALIZADO:0');
    expect(escrituras(query)).toEqual([]);
  });

  it('igual al real → ajusta normal (UPDATE, movimiento y kardex)', async () => {
    const { repo, manager, query } = conManager(10);
    await expect(repo.ajustar(9, 2, 2, 'Corrección de registro', manager, 10)).resolves.toBe(12);
    const sqls = escrituras(query);
    expect(sqls[0]).toMatch(/UPDATE inventario SET stock/);
    expect(sqls.some((sql) => sql.includes('movimientos_inventario'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('kardex'))).toBe(true);
    expect(query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE'))![1]).toEqual([12, 4]);
  });

  it('sin stockEsperado se comporta como siempre', async () => {
    const { repo, manager } = conManager(10);
    await expect(repo.ajustar(9, 2, -3, 'x', manager)).resolves.toBe(7);
  });

  it('el negocio lo traduce a 409 con código y stock actual, sin escribir', async () => {
    const { repo, manager, query } = conManager(8);
    const negocio = new InventarioBussnies(repo, {} as any);
    const error: any = await negocio
      .ajustarEnTransaccion(manager, {
        id_producto: 9,
        id_almacen: 2,
        cantidad: 2,
        motivo: 'correccion',
        comentario: 'Ajuste de stock desde edición de producto',
        stock_esperado: 10,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      codigo: 'STOCK_DESACTUALIZADO',
      stock_actual: 8,
      message:
        'El stock de este producto en ese almacén cambió mientras lo editaba: ahora hay 8. Recargue la ficha y vuelva a intentar.',
    });
    expect(escrituras(query)).toEqual([]);
  });
});

describe('InventarioRepository.stockPorProducto', () => {
  it('una consulta con todos los almacenes, el producto como parámetro y números/booleanos mapeados', async () => {
    const query = jest.fn().mockResolvedValue([
      { id_almacen: '1', almacen: 'Principal', sucursal: 'Lurín', stock: '12', registrado: true },
      { id_almacen: 3, almacen: 'Tienda', sucursal: '', stock: 0, registrado: false },
    ]);
    const repo = new InventarioRepository({} as any, { query } as any);

    await expect(repo.stockPorProducto(9)).resolves.toEqual([
      { id_almacen: 1, almacen: 'Principal', sucursal: 'Lurín', stock: 12, registrado: true },
      { id_almacen: 3, almacen: 'Tienda', sucursal: '', stock: 0, registrado: false },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([9]);
    expect(sql).toMatch(/FROM almacenes a/);
    expect(sql).toMatch(/LEFT JOIN inventario i ON i\.id_almacen = a\.id_almacen AND i\.id_producto = \$1/);
    expect(sql).toMatch(/ORDER BY a\.nombre/);
  });
});
