import { StockTiendaRepository } from './stock-tienda.repository';
import { ConfiguracionRepository } from '../configuracion.repository';

function dataSourceCon(configuracion: Record<string, string>) {
  return {
    query: jest.fn(async (sql: string, parametros: any[] = []) => {
      if (/FROM configuraciones/.test(sql)) {
        const valor = configuracion[parametros[0]];
        return valor === undefined ? [] : [{ valor }];
      }
      return [];
    }),
    transaction: jest.fn(),
  };
}

function armar(configuracion: Record<string, string> = {}) {
  const dataSource = dataSourceCon(configuracion);
  const repo = new StockTiendaRepository(dataSource as any, new ConfiguracionRepository(dataSource as any));
  return { repo, dataSource };
}

describe('StockTiendaRepository.politicaStock (R03)', () => {
  it('sale de la caché de configuración: no consulta la BD en cada página del catálogo', async () => {
    const { repo, dataSource } = armar({ tienda_stock_modo: 'exclusivo', tienda_id_almacen: '2' });

    expect(await repo.politicaStock()).toEqual({ modo: 'exclusivo', idAlmacen: 2, exclusivo: true });
    await repo.politicaStock();
    await repo.politicaStock();

    // Una lectura por clave; las siguientes salen de memoria.
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it('sin almacén web configurado no puede ser exclusivo', async () => {
    const { repo } = armar({ tienda_stock_modo: 'exclusivo' });

    expect(await repo.politicaStock()).toEqual({ modo: 'exclusivo', idAlmacen: undefined, exclusivo: false });
  });

  it('respeta el derrame (spillover) aunque haya almacén web', async () => {
    const { repo } = armar({ tienda_stock_modo: 'SPILLOVER', tienda_id_almacen: '2' });

    expect(await repo.politicaStock()).toEqual({ modo: 'spillover', idAlmacen: 2, exclusivo: false });
  });
});

describe('StockTiendaRepository.reservar', () => {
  function managerCon(filas: any[]) {
    return {
      query: jest.fn(async (sql: string, _parametros: any[] = []) => {
        if (/FROM inventario/.test(sql) && /FOR UPDATE/.test(sql)) return filas.map((f) => ({ ...f }));
        if (/FROM almacenes/.test(sql)) return [{ id_sucursal: 1 }];
        return [];
      }),
    };
  }

  it('bloquea todas las filas en una sola consulta y en el orden del POS (producto, almacén): sin deadlocks entre checkouts', async () => {
    const { repo } = armar();
    const manager = managerCon([
      { id_inventario: 10, id_producto: 5, id_almacen: 1, stock: 3 },
      { id_inventario: 11, id_producto: 5, id_almacen: 2, stock: 4 },
      { id_inventario: 20, id_producto: 8, id_almacen: 1, stock: 9 },
    ]);

    await repo.reservar([{ id_producto: 8, cantidad: 1 }, { id_producto: 5, cantidad: 6 }], undefined, 'spillover', manager as any);

    const bloqueos = manager.query.mock.calls.filter(([sql]) => /FOR UPDATE/.test(sql as string));
    expect(bloqueos).toHaveLength(1);
    expect(bloqueos[0][0]).toMatch(/ORDER BY id_producto, id_almacen, id_inventario/);
    expect(bloqueos[0][1]).toEqual([[5, 8]]);
  });

  it('en derrame toma primero el almacén con más stock y reparte el resto (igual que antes)', async () => {
    const { repo } = armar();
    const manager = managerCon([
      { id_inventario: 10, id_producto: 5, id_almacen: 1, stock: 3 },
      { id_inventario: 11, id_producto: 5, id_almacen: 2, stock: 4 },
    ]);

    const aplicadas = await repo.reservar([{ id_producto: 5, cantidad: 6 }], undefined, 'spillover', manager as any);

    expect(aplicadas).toEqual([
      { id_producto: 5, id_almacen: 2, cantidad: 4 },
      { id_producto: 5, id_almacen: 1, cantidad: 2 },
    ]);
  });

  it('con almacén preferido lo usa primero aunque tenga menos stock', async () => {
    const { repo } = armar();
    const manager = managerCon([
      { id_inventario: 10, id_producto: 5, id_almacen: 1, stock: 3 },
      { id_inventario: 11, id_producto: 5, id_almacen: 2, stock: 40 },
    ]);

    const aplicadas = await repo.reservar([{ id_producto: 5, cantidad: 4 }], 1, 'spillover', manager as any);

    expect(aplicadas).toEqual([
      { id_producto: 5, id_almacen: 1, cantidad: 3 },
      { id_producto: 5, id_almacen: 2, cantidad: 1 },
    ]);
  });

  it('sin stock suficiente corta toda la reserva', async () => {
    const { repo } = armar();
    const manager = managerCon([{ id_inventario: 10, id_producto: 5, id_almacen: 1, stock: 3 }]);

    await expect(repo.reservar([{ id_producto: 5, cantidad: 4 }], 1, 'exclusivo', manager as any)).rejects.toThrow('STOCK_INSUFICIENTE:5');
  });
});

describe('StockTiendaRepository.devolver (E11 / E14)', () => {
  it('usa la transacción de quien cancela y repone cada tramo en el almacén del que salió', async () => {
    const { repo, dataSource } = armar();
    const manager = {
      query: jest.fn(async (sql: string, parametros: any[] = []) => {
        if (/FROM pedido_items/.test(sql)) {
          return [
            { id_producto: 5, id_almacen: 1, cantidad: 3 },
            { id_producto: 5, id_almacen: 2, cantidad: 2 },
          ];
        }
        if (/SELECT id_inventario FROM inventario/.test(sql)) return [{ id_inventario: parametros[1] * 100 }];
        if (/FROM almacenes/.test(sql)) return [{ id_sucursal: 1 }];
        return [];
      }),
    };

    await repo.devolver(57, manager as any);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    const reposiciones = manager.query.mock.calls
      .filter(([sql]) => /UPDATE inventario SET stock = stock \+/.test(sql as string))
      .map(([, parametros]) => parametros);
    expect(reposiciones).toEqual([[3, 100], [2, 200]]);
  });
});
