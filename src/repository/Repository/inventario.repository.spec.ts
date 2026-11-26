import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
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

/** Error como lo entrega TypeORM con el SQLSTATE del driver dentro. */
function errorPg(code: string, mensaje: string): QueryFailedError {
  const driver = Object.assign(new Error(mensaje), { code, severity: 'ERROR', routine: 'prueba' });
  return new QueryFailedError('UPDATE inventario SET stock = 1', [], driver);
}

/**
 * Transferencia (Fase A, A4): las dos filas se bloquean en una sola sentencia y en orden fijo,
 * así dos transferencias opuestas no se interbloquean; con `stockOrigenEsperado` no se repite.
 */
describe('InventarioRepository.transferir · candados y stock esperado', () => {
  function armarTx(filas: { id_inventario: number; id_almacen: number; stock: string }[]) {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('FOR UPDATE')) return filas;
      if (sql.includes('FROM almacenes')) return [{ id_almacen: 1, id_sucursal: 10 }, { id_almacen: 2, id_sucursal: 20 }];
      return [];
    });
    const dataSource = { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn({ query })) };
    const repo = new InventarioRepository({} as any, dataSource as any);
    return { repo, query, dataSource };
  }
  const escrituras = (query: jest.Mock) =>
    query.mock.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(String(c[0])));

  it('bloquea origen y destino en UNA consulta ordenada por almacén, sea cual sea el sentido', async () => {
    const { repo, query } = armarTx([
      { id_inventario: 4, id_almacen: 1, stock: '3' },
      { id_inventario: 7, id_almacen: 2, stock: '10' },
    ]);

    // De 2 a 1: el sentido contrario al orden de bloqueo.
    await repo.transferir(9, 2, 1, 4, 'Transferencia entre almacenes');

    const bloqueos = query.mock.calls.filter((c) => String(c[0]).includes('FOR UPDATE'));
    expect(bloqueos).toHaveLength(1);
    expect(String(bloqueos[0][0])).toMatch(/WHERE id_producto = \$1 AND id_almacen = ANY\(\$2::int\[\]\)\s+ORDER BY id_almacen, id_inventario\s+FOR UPDATE/);
    expect(bloqueos[0][1]).toEqual([9, [2, 1]]);
    const updates = escrituras(query).filter((c) => String(c[0]).startsWith('UPDATE'));
    expect(updates.map((c) => [String(c[0]).includes('stock - $1') ? 'resta' : 'suma', c[1]])).toEqual([
      ['resta', [4, 7]],
      ['suma', [4, 4]],
    ]);
  });

  it('sin fila en el destino la crea con lo transferido', async () => {
    const { repo, query } = armarTx([{ id_inventario: 4, id_almacen: 1, stock: '5' }]);

    await repo.transferir(9, 1, 2, 5, 'x');

    const insert = query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO inventario'))!;
    expect(insert[1]).toEqual([9, 2, 5]);
  });

  it('stock de origen distinto del esperado → STOCK_DESACTUALIZADO:<actual> sin escribir nada', async () => {
    const { repo, query } = armarTx([{ id_inventario: 4, id_almacen: 1, stock: '6' }]);

    await expect(repo.transferir(9, 1, 2, 2, 'x', 8)).rejects.toThrow('STOCK_DESACTUALIZADO:6');
    expect(escrituras(query)).toEqual([]);
  });

  it('igual al esperado transfiere normal; sin stock suficiente sigue siendo STOCK_INSUFICIENTE', async () => {
    const igual = armarTx([{ id_inventario: 4, id_almacen: 1, stock: '6' }]);
    await expect(igual.repo.transferir(9, 1, 2, 2, 'x', 6)).resolves.toBeUndefined();

    const corto = armarTx([{ id_inventario: 4, id_almacen: 1, stock: '1' }]);
    await expect(corto.repo.transferir(9, 1, 2, 2, 'x')).rejects.toThrow('STOCK_INSUFICIENTE:1');
  });

  it('un interbloqueo repite la transacción completa', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { repo, dataSource } = armarTx([{ id_inventario: 4, id_almacen: 1, stock: '6' }]);
    const original = dataSource.transaction.getMockImplementation()!;
    dataSource.transaction.mockRejectedValueOnce(errorPg('40P01', 'deadlock detected')).mockImplementation(original);

    await expect(repo.transferir(9, 1, 2, 2, 'x')).resolves.toBeUndefined();
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('el negocio: stock desactualizado → 409 como el ajuste; error de la base → sale tal cual', async () => {
    const repo = { transferir: jest.fn().mockRejectedValueOnce(new Error('STOCK_DESACTUALIZADO:6')) };
    const negocio = new InventarioBussnies(repo as any, {} as any);
    const dto = { id_producto: 9, id_almacen_origen: 1, id_almacen_destino: 2, cantidad: 2, stock_origen_esperado: 8 };

    const error: any = await negocio.transferir(dto).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      codigo: 'STOCK_DESACTUALIZADO',
      stock_actual: 6,
      message:
        'El stock de este producto en ese almacén cambió mientras lo editaba: ahora hay 6. Recargue la ficha y vuelva a intentar.',
    });
    // Fase 8.1: el último argumento es el rastro (quién transfiere; sin usuario en esta llamada).
    expect(repo.transferir).toHaveBeenCalledWith(9, 1, 2, 2, 'Transferencia entre almacenes', 8, { id_usuario: null });

    const deBase = errorPg('40P01', 'deadlock detected');
    repo.transferir.mockRejectedValueOnce(deBase);
    const otro = await negocio.transferir(dto).catch((e) => e);
    expect(otro).toBe(deBase);
    expect(otro).not.toBeInstanceOf(BadRequestException);
  });
});

describe('InventarioRepository.ajustar · reintento', () => {
  it('sin manager repite su propia transacción tras un interbloqueo; con manager no repite', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const query = jest.fn(async (sql: string) => (sql.includes('FOR UPDATE') ? [{ id_inventario: 4, stock: '10' }] : []));
    const transaction = jest.fn()
      .mockRejectedValueOnce(errorPg('40P01', 'deadlock detected'))
      .mockImplementation(async (fn: (m: unknown) => unknown) => fn({ query }));
    const repo = new InventarioRepository({} as any, { transaction } as any);

    await expect(repo.ajustar(9, 2, 2, 'x')).resolves.toBe(12);
    expect(transaction).toHaveBeenCalledTimes(2);

    const conflicto = errorPg('40P01', 'deadlock detected');
    const ajeno = { query: jest.fn().mockRejectedValue(conflicto) };
    await expect(repo.ajustar(9, 2, 2, 'x', ajeno as any)).rejects.toBe(conflicto);
    expect(ajeno.query).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('el negocio deja pasar el error de la base del ajuste sin convertirlo en 400', async () => {
    const deBase = errorPg('22003', 'integer out of range');
    const repo = { ajustar: jest.fn().mockRejectedValue(deBase) };
    const negocio = new InventarioBussnies(repo as any, { getById: jest.fn().mockResolvedValue({ id_producto: 9 }) } as any);

    const error = await negocio.ajustar({ id_producto: 9, id_almacen: 2, cantidad: 2, motivo: 'correccion' }).catch((e) => e);
    expect(error).toBe(deBase);
  });
});

describe('InventarioRepository.listarDetallado · comodines escritos por el usuario (B8)', () => {
  it('`%`, `_` y `\\` se buscan tal cual: van escapados y cada LIKE lleva ESCAPE', async () => {
    const { repo, pendientes } = armar();

    const promesa = repo.listarDetallado({ texto: ' Cinta_50%\\X ' });
    await Promise.resolve();
    const conteo = pendientes.find((p) => p.sql.includes('COUNT(*)'))!;
    const filas = pendientes.find((p) => !p.sql.includes('COUNT(*)'))!;

    expect(conteo.params[0]).toBe('%cinta\\_50\\%\\\\x%');
    for (const { sql } of [conteo, filas]) {
      expect(sql.match(/LIKE \$1 ESCAPE '\\'/g)).toHaveLength(3);
    }

    conteo.resolver([{ total: 0 }]);
    filas.resolver([]);
    await promesa;
  });
});

describe('InventarioBussnies.ajustar · bitácora (Fase 6.3)', () => {
  it('después del ajuste anota quién, el almacén, el stock antes y después y el motivo', async () => {
    const repo = { ajustar: jest.fn().mockResolvedValue(7) };
    const bitacora = dobleBitacora();
    const negocio = new InventarioBussnies(repo as any, { getById: jest.fn().mockResolvedValue({ id_producto: 9 }) } as any, bitacora as any);

    const r = await negocio.ajustar(
      { id_producto: 9, id_almacen: 2, cantidad: -3, motivo: 'merma', comentario: 'caja rota' },
      { id_usuario: 4, rol: 'vendedor' } as any,
    );

    expect(r).toEqual({ id_producto: 9, id_almacen: 2, stock: 7 });
    expect(bitacora.registrar).toHaveBeenCalledWith({
      accion: 'inventario.ajuste',
      id_usuario: 4,
      rol: 'vendedor',
      id_almacen: 2,
      entidad: 'producto',
      id_entidad: 9,
      antes: { stock: 10 },
      despues: { stock: 7, cantidad: -3, motivo: 'merma' },
      motivo: 'Merma o producto dañado · caja rota',
    });
    expect(bitacora.registrar.mock.invocationCallOrder[0]).toBeGreaterThan(repo.ajustar.mock.invocationCallOrder[0]);
  });

  it('si el ajuste falla no anota; sin bitácora (o sin usuario) el ajuste funciona como antes', async () => {
    const bitacora = dobleBitacora();
    const falla = new InventarioBussnies(
      { ajustar: jest.fn().mockRejectedValue(new Error('STOCK_NEGATIVO:1')) } as any,
      { getById: jest.fn().mockResolvedValue({ id_producto: 9 }) } as any,
      bitacora as any,
    );
    await expect(falla.ajustar({ id_producto: 9, id_almacen: 2, cantidad: -3, motivo: 'merma' })).rejects.toBeInstanceOf(BadRequestException);
    expect(bitacora.registrar).not.toHaveBeenCalled();

    const sinBitacora = new InventarioBussnies({ ajustar: jest.fn().mockResolvedValue(5) } as any, { getById: jest.fn().mockResolvedValue({ id_producto: 9 }) } as any);
    await expect(sinBitacora.ajustar({ id_producto: 9, id_almacen: 2, cantidad: 2, motivo: 'compra' })).resolves.toEqual({ id_producto: 9, id_almacen: 2, stock: 5 });
  });
});


/** Doble de BitacoraService: `registrarCon` arma el evento (como el servicio real) y lo pasa a `registrar`, que es lo que miran las pruebas. */
function dobleBitacora() {
  const registrar = jest.fn(async (_evento: any) => undefined);
  const registrarCon = jest.fn(async (fabrica: () => any) => {
    const r = fabrica();
    for (const e of Array.isArray(r) ? r : [r]) if (e) await registrar(e);
  });
  return { registrar, registrarCon };
}

describe('InventarioRepository: rastro de los movimientos (Fase 8.1, fase21)', () => {
  function armarRastro(capacidades: string[], filasInventario: any[] = [{ id_inventario: 4, stock: '10' }]) {
    const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<any[]> => {
      if (sql.includes('FOR UPDATE') && sql.includes('ANY($2::int[])')) {
        return [{ id_inventario: 4, id_almacen: 1, stock: '10' }];
      }
      if (sql.includes('FOR UPDATE')) return filasInventario;
      if (sql.includes('FROM almacenes')) return [{ id_almacen: 1, id_sucursal: 10 }, { id_almacen: 2, id_sucursal: 20 }];
      return [];
    });
    const dataSource = { query, transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn({ query })) };
    const esquema = { tiene: jest.fn(async (c: string) => capacidades.includes(c)) };
    const repo = new InventarioRepository({} as any, dataSource as any, esquema as any);
    const movimiento = () => query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO movimientos_inventario'))!;
    return { repo, query, movimiento };
  }
  const TODAS = ['movimientoUsuario', 'movimientoAlmacen', 'movimientoDocumento'];

  it('ajuste con fase21 (columnas presentes): guarda usuario, almacén y documento', async () => {
    const { repo, movimiento } = armarRastro(TODAS);

    await repo.ajustar(9, 2, -3, 'Merma o producto dañado', undefined, undefined, { id_usuario: 7, tipo_documento: 'ajuste', id_documento: null });

    const [sql, params] = movimiento();
    expect(String(sql)).toContain('descripcion, fecha, id_usuario, id_almacen, tipo_documento, id_documento)');
    expect(String(sql)).toContain('NOW(), $7::int, $8::int, $9::varchar, $10::int)');
    expect(params).toEqual([9, 'salida', 3, 10, null, 'Merma o producto dañado', 7, 2, 'ajuste', null]);
  });

  it('ajuste sin fase21 (columnas ausentes): el INSERT es exactamente el de antes, aunque llegue el rastro', async () => {
    const { repo, movimiento } = armarRastro([]);

    await repo.ajustar(9, 2, 3, 'x', undefined, undefined, { id_usuario: 7, tipo_documento: 'ajuste' });

    const [sql, params] = movimiento();
    expect(String(sql)).toMatch(/descripcion, fecha\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, NOW\(\)\)/);
    expect(params).toHaveLength(6);
  });

  it('transferencia con fase21: tipo transferencia, almacén de origen y quién transfirió', async () => {
    const { repo, movimiento } = armarRastro(TODAS);

    await repo.transferir(9, 1, 2, 4, 'Transferencia entre almacenes', undefined, { id_usuario: 7 });

    const [sql, params] = movimiento();
    expect(String(sql)).toContain("VALUES ($1, 'transferencia', $2, $3, $4, $5, NOW(), $6::int, $7::int, $8::varchar, $9::int)");
    expect(params).toEqual([9, 4, 10, 20, 'Transferencia entre almacenes', 7, 1, 'transferencia', null]);
  });

  it('lectura del historial del producto: con fase21 trae quién, dónde y por qué; pagina sin COUNT', async () => {
    const { repo, query } = armarRastro(TODAS);
    const filas = Array.from({ length: 3 }, (_, i) => ({
      id_movimiento: 10 - i, fecha: '2026-11-25T10:00:00Z', tipo: 'salida', cantidad: '2', descripcion: 'Venta en mostrador',
      sucursal_origen: 'Central', sucursal_destino: '', id_usuario: 7, usuario: 'Ana', id_almacen: 1, almacen: 'Principal',
      tipo_documento: 'venta', id_documento: 50,
    }));
    query.mockImplementationOnce(async () => filas);

    const pagina = await repo.movimientosDeProducto(9, { pagina: 1, por_pagina: 2, id_almacen: 1 });

    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario');
    expect(String(sql)).toContain('AND m.id_almacen = $2');
    expect(params).toEqual([9, 1, 3, 0]);
    expect(pagina.hay_mas).toBe(true);
    expect(pagina.datos).toHaveLength(2);
    expect(pagina.datos[0]).toMatchObject({ usuario: 'Ana', almacen: 'Principal', tipo_documento: 'venta', id_documento: 50, cantidad: 2 });
    expect(pagina.rastro).toEqual({ usuario: true, almacen: true, documento: true });
  });

  it('lectura sin fase21: no toca columnas inexistentes y el rastro sale en null', async () => {
    const { repo, query } = armarRastro([]);
    query.mockImplementationOnce(async () => [{ id_movimiento: 1, tipo: 'entrada', cantidad: 5, id_usuario: null, usuario: null }]);

    const pagina = await repo.movimientosDeProducto(9, { id_almacen: 1 });

    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).not.toMatch(/m\.id_usuario|m\.id_almacen|m\.tipo_documento/);
    expect(params).toEqual([9, 31, 0]);
    expect(pagina.datos[0]).toMatchObject({ id_usuario: null, almacen: null, tipo_documento: null });
    expect(pagina.rastro).toEqual({ usuario: false, almacen: false, documento: false });
  });
});
