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

describe('VentaTiendaRepository · datos del comprobante del pedido (S5)', () => {
  function conDataSource(filas: Record<string, unknown>[]) {
    const query = jest.fn(async () => filas);
    return { repo: new VentaTiendaRepository({ query, transaction: jest.fn() } as any), query };
  }

  it('lee del pedido el tipo, el documento, el nombre, el correo y la dirección de envío', async () => {
    const { repo, query } = conDataSource([{
      id_pedido: 57, codigo: 'PED-1', id_venta: 99, id_cliente: 3, tipo_comprobante: 'factura',
      documento_receptor: ' 20123456789 ', nombre_receptor: 'Constructora Andina SAC', correo: 'compras@andina.pe',
      direccion: 'Av. Perú 123, Cusco',
    }]);

    await expect(repo.datosParaComprobante(57)).resolves.toEqual({
      id_pedido: 57, codigo: 'PED-1', id_venta: 99, id_cliente: 3, tipo_comprobante: 'factura',
      documento_receptor: '20123456789', nombre_receptor: 'Constructora Andina SAC', correo: 'compras@andina.pe',
      direccion: 'Av. Perú 123, Cusco',
    });
    expect((query.mock.calls[0] as any[])[1]).toEqual([57]);
  });

  it('sin tipo o con un tipo raro el comprobante es boleta; los vacíos pasan a null', async () => {
    const { repo } = conDataSource([{
      id_pedido: 58, codigo: 'PED-2', id_venta: null, id_cliente: 4, tipo_comprobante: null,
      documento_receptor: '  ', nombre_receptor: '', correo: null, direccion: null,
    }]);

    await expect(repo.datosParaComprobante(58)).resolves.toMatchObject({
      tipo_comprobante: 'boleta', id_venta: null, documento_receptor: null, nombre_receptor: null, correo: null, direccion: null,
    });
  });

  it('un pedido inexistente devuelve null', async () => {
    const { repo } = conDataSource([]);
    await expect(repo.datosParaComprobante(404)).resolves.toBeNull();
  });

  it('enlaza el comprobante al pedido sin pisar un enlace anterior', async () => {
    const { repo, query } = conDataSource([]);

    await repo.vincularComprobante(57, 12);

    const [sql, parametros] = query.mock.calls[0] as any[];
    expect(sql).toMatch(/UPDATE pedidos SET id_comprobante/);
    expect(sql).toMatch(/id_comprobante IS NULL/);
    expect(parametros).toEqual([12, 57]);
  });
});
