import { RecepcionRepository } from './recepcion.repository';

/**
 * DataSource falso: registra cada sentencia (y si corrió dentro de la transacción) y
 * responde según el SQL. UPDATE y DELETE devuelven [filas, afectadas] como TypeORM 0.3.
 */
function armar(responder: (sql: string, params: any[]) => any) {
  const sentencias: { sql: string; params: any[]; enTransaccion: boolean }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      sentencias.push({ sql, params, enTransaccion: true });
      return responder(sql, params);
    }),
  };
  const dataSource = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      sentencias.push({ sql, params, enTransaccion: false });
      return responder(sql, params);
    }),
    transaction: jest.fn(async (trabajo: (m: any) => Promise<any>) => trabajo(manager)),
  };
  const repo = new RecepcionRepository(dataSource as any);
  const enTransaccion = () => sentencias.filter((s) => s.enTransaccion);
  return { repo, manager, dataSource, sentencias, enTransaccion };
}

const fila = { id_observacion: 9, id_producto: 3, id_almacen: 1, cantidad: '5.000', estado: 'aprobado' };

describe('RecepcionRepository.revisarObservacion', () => {
  it('marca primero con UPDATE condicional y suma el stock con el mismo manager', async () => {
    const { repo, manager, enTransaccion } = armar((sql) => (sql.includes('UPDATE recepcion_observaciones') ? [[fila], 1] : []));
    const alRevisar = jest.fn().mockResolvedValue(undefined);

    const r = await repo.revisarObservacion(9, 'aprobado', 1, 'ok', alRevisar);

    expect(r).toEqual({ resultado: 'revisada', observacion: fila });
    const primera = enTransaccion()[0].sql;
    expect(primera).toMatch(/UPDATE recepcion_observaciones/);
    expect(primera).toMatch(/WHERE id_observacion = \$1 AND estado = 'pendiente'/);
    expect(alRevisar).toHaveBeenCalledWith(manager, fila);
  });

  it('si ya no estaba pendiente no suma nada e informa su estado', async () => {
    const { repo } = armar((sql) => {
      if (sql.includes('UPDATE recepcion_observaciones')) return [[], 0];
      if (sql.includes('SELECT estado FROM recepcion_observaciones')) return [{ estado: 'rechazado' }];
      return [];
    });
    const alRevisar = jest.fn();

    await expect(repo.revisarObservacion(9, 'aprobado', 1, '', alRevisar)).resolves.toEqual({
      resultado: 'ya_revisada',
      estado: 'rechazado',
    });
    expect(alRevisar).not.toHaveBeenCalled();
  });

  it('distingue la observación inexistente', async () => {
    const { repo } = armar((sql) => (sql.includes('UPDATE recepcion_observaciones') ? [[], 0] : []));

    await expect(repo.revisarObservacion(1234, 'rechazado', 1, '')).resolves.toEqual({ resultado: 'no_existe' });
  });
});

describe('RecepcionRepository.registrarRecepcion', () => {
  const params = {
    id_proveedor: 2,
    id_almacen: 1,
    nro_guia: 'G-1',
    nro_documento: '',
    observaciones: '',
    id_usuario: 4,
    items: [{ id_producto: 3, cantidad_ok: 2, cantidad_observada: 1, motivo_observacion: 'golpe' }],
  };

  function responderNuevo(conColumna: boolean, previa: any[] = []) {
    return (sql: string) => {
      if (sql.includes('information_schema.columns')) return conColumna ? [{ '?column?': 1 }] : [];
      if (sql.includes('FROM recepciones WHERE clave_idempotencia')) return previa;
      if (sql.includes('INSERT INTO recepciones')) return [{ id_recepcion: 50 }];
      if (sql.includes('INSERT INTO recepcion_items')) return [{ id_item: 7 }];
      if (sql.includes('INSERT INTO recepcion_observaciones')) return [{ id_observacion: 90 }];
      if (sql.includes('FROM recepcion_observaciones')) return [{ id_observacion: 90, id_producto: 3, id_item: 7 }];
      return [];
    };
  }

  it('todo va en una transacción: cabecera, líneas, observación y el stock con el mismo manager', async () => {
    const { repo, manager, enTransaccion } = armar(responderNuevo(true));
    const aplicarStock = jest.fn().mockResolvedValue(undefined);

    const r = await repo.registrarRecepcion({ ...params, clave: 'abc-1' }, aplicarStock);

    expect(r).toEqual({
      id_recepcion: 50,
      observaciones: [{ id_observacion: 90, id_producto: 3, id_item: 7 }],
      repetida: false,
    });
    const sqls = enTransaccion().map((s) => s.sql);
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(sqls[1]).toMatch(/WHERE clave_idempotencia = \$1/);
    const insert = enTransaccion().find((s) => s.sql.includes('INSERT INTO recepciones'))!;
    expect(insert.sql).toMatch(/clave_idempotencia/);
    expect(insert.params).toContain('abc-1');
    expect(aplicarStock).toHaveBeenCalledWith(manager, { id_recepcion: 50 });
  });

  it('un reintento con la misma clave devuelve la recepción previa sin insertar ni sumar stock', async () => {
    const { repo, enTransaccion } = armar(responderNuevo(true, [{ id_recepcion: 50 }]));
    const aplicarStock = jest.fn();

    const r = await repo.registrarRecepcion({ ...params, clave: 'abc-1' }, aplicarStock);

    expect(r.repetida).toBe(true);
    expect(r.id_recepcion).toBe(50);
    expect(r.observaciones).toEqual([{ id_observacion: 90, id_producto: 3, id_item: 7 }]);
    expect(enTransaccion().some((s) => s.sql.includes('INSERT'))).toBe(false);
    expect(aplicarStock).not.toHaveBeenCalled();
  });

  it('sin la columna de fase16 registra igual (sin clave ni candado)', async () => {
    const { repo, enTransaccion } = armar(responderNuevo(false));
    const aplicarStock = jest.fn().mockResolvedValue(undefined);

    const r = await repo.registrarRecepcion({ ...params, clave: 'abc-1' }, aplicarStock);

    expect(r.repetida).toBe(false);
    expect(enTransaccion().some((s) => s.sql.includes('pg_advisory_xact_lock'))).toBe(false);
    const insert = enTransaccion().find((s) => s.sql.includes('INSERT INTO recepciones'))!;
    expect(insert.sql).not.toMatch(/clave_idempotencia/);
    expect(aplicarStock).toHaveBeenCalledTimes(1);
  });

  it('si sumar el stock falla, el error sale de la transacción (se deshace todo)', async () => {
    const { repo, dataSource } = armar(responderNuevo(false));

    await expect(
      repo.registrarRecepcion(params, async () => {
        throw new Error('STOCK_FUERA_DE_RANGO:2147483647');
      }),
    ).rejects.toThrow('STOCK_FUERA_DE_RANGO');
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('si otro proceso ganó la misma clave (23505) responde con esa recepción', async () => {
    let intentos = 0;
    const { repo, dataSource } = armar(responderNuevo(true));
    dataSource.transaction.mockImplementationOnce(async () => {
      intentos += 1;
      throw Object.assign(new Error('duplicate key value violates unique constraint "uq_recepciones_clave_idempotencia"'), { code: '23505' });
    });
    dataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) return [{ '?column?': 1 }];
      if (sql.includes('FROM recepciones WHERE clave_idempotencia')) return [{ id_recepcion: 51 }];
      return [];
    });

    const r = await repo.registrarRecepcion({ ...params, clave: 'abc-2' }, jest.fn());

    expect(intentos).toBe(1);
    expect(r).toEqual({ id_recepcion: 51, observaciones: [], repetida: true });
  });
});

describe('RecepcionRepository · proveedores (UPDATE/DELETE devuelven [filas, afectadas])', () => {
  it('actualizarProveedor devuelve la fila, no el arreglo', async () => {
    const proveedor = { id_proveedor: 2, nombre: 'ACME' };
    const { repo } = armar(() => [[proveedor], 1]);

    await expect(repo.actualizarProveedor(2, { nombre: 'ACME' })).resolves.toEqual(proveedor);
  });

  it('eliminarProveedor informa cuando no había nada que borrar', async () => {
    const { repo } = armar((sql) => (sql.startsWith('SELECT COUNT') ? [{ n: 0 }] : [[], 0]));

    await expect(repo.eliminarProveedor(999)).resolves.toBe(false);
  });
});
