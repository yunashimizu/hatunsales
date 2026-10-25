import { VentaTiendaRepository } from './venta-tienda.repository';

/**
 * La venta que nace de un pedido web toma el stock que el pedido había
 * reservado (E11): queda en `venta_stock_salida` por almacén, así la anulación
 * de la venta (o una nota de crédito por devolución) lo repone donde salió, y el
 * pedido ya no lo devuelve otra vez si después se cancela.
 */
function armar(pedido: Record<string, unknown> | null, opciones: { conStockSalida?: boolean } = {}) {
  const consultas: { sql: string; parametros: any[] }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, parametros: any[] = []) => {
      consultas.push({ sql, parametros });
      if (/FROM pedidos/.test(sql) && /FOR UPDATE/.test(sql)) return pedido ? [pedido] : [];
      if (/to_regclass/.test(sql)) return [{ existe: opciones.conStockSalida ?? true }];
      if (/FROM cajas/.test(sql)) return [{ id_caja: 3 }];
      if (/INSERT INTO ventas/.test(sql)) return [{ id_venta: 99 }];
      return [];
    }),
  };
  const dataSource = { transaction: jest.fn(async (trabajo: (m: any) => Promise<any>) => trabajo(manager)) };
  const buscar = (patron: RegExp) => consultas.find((c) => patron.test(c.sql));
  return { repo: new VentaTiendaRepository(dataSource as any), consultas, buscar };
}

const PAGADO = {
  id_pedido: 57,
  id_cliente: 3,
  id_venta: null,
  estado: 'pagado',
  stock_reservado: true,
  subtotal: '42.37',
  igv: '7.63',
  total: '50.00',
  id_metodo_pago: 7,
};

describe('VentaTiendaRepository.generarDesdePedido', () => {
  it('pasa el stock reservado a venta_stock_salida y el pedido deja de reservarlo', async () => {
    const { repo, buscar } = armar(PAGADO);

    await expect(repo.generarDesdePedido(57)).resolves.toBe(99);

    const salida = buscar(/INSERT INTO venta_stock_salida/);
    expect(salida?.parametros).toEqual([99, 57]);
    expect(salida?.sql).toMatch(/GROUP BY pi\.id_producto, pi\.id_almacen/);
    expect(buscar(/UPDATE pedidos/)?.sql).toMatch(/stock_reservado = FALSE/);
  });

  it('una línea que salió de dos almacenes va al detalle de la venta como una sola', async () => {
    const { repo, buscar } = armar(PAGADO);

    await repo.generarDesdePedido(57);

    expect(buscar(/INSERT INTO detalle_venta/)?.sql).toMatch(/GROUP BY pi\.id_producto, pi\.precio_unitario/);
  });

  it('no genera venta para un pedido cancelado', async () => {
    const { repo, buscar } = armar({ ...PAGADO, estado: 'cancelado' });

    await expect(repo.generarDesdePedido(57)).resolves.toBeNull();
    expect(buscar(/INSERT INTO ventas/)).toBeUndefined();
  });

  it('es idempotente: si el pedido ya tiene venta la devuelve sin crear otra', async () => {
    const { repo, buscar } = armar({ ...PAGADO, id_venta: 98 });

    await expect(repo.generarDesdePedido(57)).resolves.toBe(98);
    expect(buscar(/INSERT INTO ventas/)).toBeUndefined();
  });

  it('si el pedido no reservó stock no hay salida que copiar', async () => {
    const { repo, buscar } = armar({ ...PAGADO, stock_reservado: false });

    await repo.generarDesdePedido(57);

    expect(buscar(/INSERT INTO venta_stock_salida/)).toBeUndefined();
  });

  it('sin la tabla venta_stock_salida el pedido conserva su reserva (comportamiento anterior)', async () => {
    const { repo, buscar } = armar(PAGADO, { conStockSalida: false });

    await repo.generarDesdePedido(57);

    expect(buscar(/INSERT INTO venta_stock_salida/)).toBeUndefined();
    expect(buscar(/UPDATE pedidos/)?.sql).not.toMatch(/stock_reservado/);
  });
});
