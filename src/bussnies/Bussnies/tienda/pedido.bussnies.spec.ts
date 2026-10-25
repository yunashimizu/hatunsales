import { BadRequestException, ConflictException } from '@nestjs/common';
import { PedidoBussnies } from './pedido.bussnies';

function itemCarrito(parcial: Record<string, unknown> = {}) {
  return {
    id_item: 1,
    id_producto: 5,
    nombre: 'Taladro percutor',
    imagen: null,
    cantidad: 5,
    precio_unitario: 10,
    subtotal: 50,
    stock_disponible: 9,
    excede_stock: false,
    ...parcial,
  };
}

function lineaPedido(id: number, idProducto: number, cantidad: number, idAlmacen: number) {
  const total = cantidad * 10;
  return {
    id_pedido_item: id,
    producto: { id_producto: idProducto, nombre: 'Taladro percutor' },
    nombre_producto: 'Taladro percutor',
    cantidad,
    precio_unitario: '10.00',
    subtotal: String(Math.round((total / 1.18) * 100) / 100),
    igv: String(Math.round((total - total / 1.18) * 100) / 100),
    total: String(total),
    id_almacen: idAlmacen,
  };
}

function pedidoBase(parcial: Record<string, unknown> = {}) {
  return {
    id_pedido: 57,
    codigo: 'PED-20261021-0057',
    estado: 'pendiente',
    cliente: { id_cliente: 3 },
    subtotal: '42.37',
    igv: '7.63',
    descuento: '0',
    costo_envio: '0',
    total: '50',
    stock_reservado: true,
    id_venta: null,
    items: [],
    historial: [],
    creado_en: new Date('2026-10-21T20:00:00Z'),
    ...parcial,
  };
}

function armar(opciones: {
  items?: any[];
  reservas?: any[];
  pedido?: Record<string, unknown>;
  direccionDelCliente?: boolean;
  estadoVenta?: string | null;
} = {}) {
  const manager = { esElManagerDeLaTransaccion: true };
  const repo = {
    buscarPorClaveIdempotencia: jest.fn(async (): Promise<any> => null),
    crear: jest.fn(async (datos: any) => ({ ...datos, id_pedido: 57 })),
    asignarCodigo: jest.fn(async () => undefined),
    guardarItems: jest.fn(async (filas: any[]) => filas),
    marcarStockReservado: jest.fn(async () => undefined),
    registrarEstado: jest.fn(async () => undefined),
    transicionarEstado: jest.fn(async (): Promise<any> => ({ id_pedido: 57, stock_reservado: true, id_venta: null })),
    obtenerPorId: jest.fn(async (): Promise<any> => pedidoBase(opciones.pedido)),
    estadoVenta: jest.fn(async () => opciones.estadoVenta ?? null),
    // API anterior a la corrección (cambio de estado sin condición).
    cambiarEstado: jest.fn(async () => undefined),
    contarDelDia: jest.fn(async () => 0),
    asignarAlmacenAItems: jest.fn(async () => undefined),
  };
  const carrito = { id_carrito: 4 };
  const items = opciones.items ?? [itemCarrito()];
  const resumen = { id_carrito: 4, items, cantidad_items: 5, subtotal: 42.37, igv: 7.63, total: 50 };
  const carritoBussnies = {
    buscar: jest.fn(async () => carrito),
    obtenerOCrear: jest.fn(async () => carrito),
    armarRespuesta: jest.fn(async () => resumen),
    desagregarIgv: (total: number) => {
      const subtotal = Math.round((total / 1.18 + Number.EPSILON) * 100) / 100;
      return { subtotal, igv: Math.round((total - subtotal + Number.EPSILON) * 100) / 100 };
    },
  };
  const carritoRepo = { vaciar: jest.fn(async () => undefined), marcarConvertido: jest.fn(async () => undefined) };
  const checkoutBussnies = {
    costoEnvio: jest.fn(async () => 0),
    validarMetodoPago: jest.fn(async () => undefined),
    validarCupon: jest.fn(),
    registrarUso: jest.fn(),
  };
  const stockRepo = {
    configuracion: jest.fn(async () => 'true'),
    politicaStock: jest.fn(async () => ({ modo: 'spillover', exclusivo: false })),
    reservar: jest.fn(async () => opciones.reservas ?? [{ id_producto: 5, id_almacen: 1, cantidad: 5 }]),
    devolver: jest.fn(async () => undefined),
  };
  const dataSource = { transaction: jest.fn(async (trabajo: (m: any) => Promise<any>) => trabajo(manager)) };
  const cuentaRepo = {
    obtenerDireccion: jest.fn(async (id: number) => (opciones.direccionDelCliente === false ? null : { id_direccion: id })),
  };

  const servicio = new PedidoBussnies(
    repo as any,
    carritoRepo as any,
    carritoBussnies as any,
    checkoutBussnies as any,
    stockRepo as any,
    dataSource as any,
    cuentaRepo as any,
  );

  return { servicio, repo, stockRepo, checkoutBussnies, dataSource, manager };
}

function errorUnico(restriccion: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${restriccion}"`), {
    code: '23505',
    constraint: restriccion,
  });
}

describe('PedidoBussnies · checkout', () => {
  it('rechaza una dirección que no es del cliente y no crea el pedido (E04)', async () => {
    const { servicio, repo } = armar({ direccionDelCliente: false });

    await expect(servicio.crearDesdeCarrito(3, { id_direccion: 99 })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.crear).not.toHaveBeenCalled();
  });

  it('valida que el método de pago elegido esté activo (E04)', async () => {
    const { servicio, repo, checkoutBussnies } = armar();
    checkoutBussnies.validarMetodoPago.mockRejectedValueOnce(
      new BadRequestException('El método de pago seleccionado no está disponible'),
    );

    await expect(servicio.crearDesdeCarrito(3, { id_metodo_pago: 1 })).rejects.toThrow('no está disponible');
    expect(repo.crear).not.toHaveBeenCalled();
  });

  it('no crea el pedido si cambió un precio: avisa para que el cliente confirme el nuevo total (E03)', async () => {
    const { servicio, repo } = armar({ items: [itemCarrito({ precio_cambio: true, precio_anterior: 8 })] });

    const error = await servicio.crearDesdeCarrito(3, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'PRECIOS_ACTUALIZADOS' });
    expect(repo.crear).not.toHaveBeenCalled();
  });

  it('no crea el pedido con productos retirados del catálogo (E03)', async () => {
    const { servicio, repo } = armar({ items: [itemCarrito({ no_disponible: true })] });

    await expect(servicio.crearDesdeCarrito(3, {})).rejects.toThrow(/Ya no vendemos/);
    expect(repo.crear).not.toHaveBeenCalled();
  });

  it('guarda un tramo por almacén cuando la reserva salió de dos almacenes (E14)', async () => {
    const { servicio, repo } = armar({
      reservas: [
        { id_producto: 5, id_almacen: 1, cantidad: 3 },
        { id_producto: 5, id_almacen: 2, cantidad: 2 },
      ],
    });

    await servicio.crearDesdeCarrito(3, {});

    const filas = repo.guardarItems.mock.calls[0][0] as any[];
    expect(filas.map((f) => [f.cantidad, f.id_almacen, f.total])).toEqual([[3, 1, 30], [2, 2, 20]]);
    for (const fila of filas) {
      expect(Math.round((fila.subtotal + fila.igv) * 100)).toBe(Math.round(fila.total * 100));
    }
  });

  it('arma el código con la fecha de Lima y el id del pedido, sin COUNT del día (E15)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T01:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const { servicio, repo, manager } = armar();

      await servicio.crearDesdeCarrito(3, {});

      // 01:30 UTC del 22/10 son las 20:30 del 21/10 en Lima.
      expect(repo.asignarCodigo).toHaveBeenCalledWith(57, 'PED-20261021-0057', manager);
      expect(repo.contarDelDia).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('un choque de unicidad que no es la clave de idempotencia responde un conflicto claro (E15)', async () => {
    const { servicio, dataSource } = armar();
    dataSource.transaction.mockRejectedValueOnce(errorUnico('pedidos_codigo_key'));

    await expect(servicio.crearDesdeCarrito(3, { clave_idempotencia: 'k-1' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('dos envíos simultáneos con la misma clave devuelven el pedido que ganó la carrera', async () => {
    const { servicio, repo, dataSource } = armar();
    repo.buscarPorClaveIdempotencia
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pedidoBase({ id_pedido: 56, codigo: 'PED-20261021-0056' }));
    dataSource.transaction.mockRejectedValueOnce(errorUnico('uq_pedidos_idempotencia'));

    const respuesta = await servicio.crearDesdeCarrito(3, { clave_idempotencia: 'k-1' });

    expect(respuesta.codigo).toBe('PED-20261021-0056');
  });
});

describe('PedidoBussnies · cancelación y cambios de estado (E11)', () => {
  it('el cliente no puede cancelar en línea un pedido ya pagado', async () => {
    const { servicio, repo, stockRepo } = armar({ pedido: { estado: 'pagado' } });

    await expect(servicio.cancelar(57, 3)).rejects.toThrow(/pago ya fue confirmado/);
    expect(stockRepo.devolver).not.toHaveBeenCalled();
    expect(repo.transicionarEstado).not.toHaveBeenCalled();
    expect(repo.cambiarEstado).not.toHaveBeenCalled();
  });

  it('cancelar un pendiente cambia el estado y devuelve el stock en la misma transacción', async () => {
    const { servicio, repo, stockRepo, manager } = armar({ pedido: { estado: 'pendiente' } });

    await servicio.cancelar(57, 3, 'Me equivoqué de producto');

    expect(repo.transicionarEstado).toHaveBeenCalledWith(
      57, ['pendiente'], 'cancelado', 'Me equivoqué de producto', manager, { sinVentaVigente: true },
    );
    expect(stockRepo.devolver).toHaveBeenCalledWith(57, manager);
    expect(repo.marcarStockReservado).toHaveBeenCalledWith(57, false, undefined, manager);
  });

  it('si el pago se confirmó justo antes, la cancelación no procede ni devuelve stock', async () => {
    const { servicio, repo, stockRepo } = armar();
    repo.transicionarEstado.mockResolvedValueOnce(null);
    repo.obtenerPorId
      .mockResolvedValueOnce(pedidoBase({ estado: 'pendiente' }))
      .mockResolvedValueOnce(pedidoBase({ estado: 'pagado' }));

    await expect(servicio.cancelar(57, 3)).rejects.toThrow(/pago ya fue confirmado/);
    expect(stockRepo.devolver).not.toHaveBeenCalled();
  });

  it('el panel no cancela un pedido con venta vigente: pide anularla primero', async () => {
    const { servicio, stockRepo } = armar({ pedido: { estado: 'pagado', id_venta: 99, stock_reservado: false }, estadoVenta: 'activa' });

    await expect(servicio.cambiarEstado(57, 'cancelado')).rejects.toThrow(/Anúlala primero/);
    expect(stockRepo.devolver).not.toHaveBeenCalled();
  });

  it('con la venta ya anulada, el panel cancela sin devolver el stock otra vez', async () => {
    const { servicio, repo, stockRepo } = armar({ pedido: { estado: 'pagado', id_venta: 99 }, estadoVenta: 'anulada' });
    repo.transicionarEstado.mockResolvedValueOnce({ id_pedido: 57, stock_reservado: true, id_venta: 99 });

    await servicio.cambiarEstado(57, 'cancelado', 'El cliente desistió');

    expect(stockRepo.devolver).not.toHaveBeenCalled();
    expect(repo.marcarStockReservado).toHaveBeenCalledWith(57, false, undefined, expect.anything());
  });

  it('el panel no marca "pagado" a mano: eso pasa por Confirmar pago', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.cambiarEstado(57, 'pagado')).rejects.toThrow(/Confirmar pago/);
    expect(repo.cambiarEstado).not.toHaveBeenCalled();
  });

  it('un pedido no retrocede en el flujo', async () => {
    const { servicio, repo } = armar({ pedido: { estado: 'enviado' } });

    await expect(servicio.cambiarEstado(57, 'preparando')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.cambiarEstado).not.toHaveBeenCalled();
  });

  it('un avance es condicional: si otro proceso movió el pedido, responde conflicto', async () => {
    const { servicio, repo } = armar({ pedido: { estado: 'pagado' } });
    repo.transicionarEstado.mockResolvedValueOnce(null);

    await expect(servicio.cambiarEstado(57, 'preparando')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PedidoBussnies · respuesta', () => {
  it('muestra los tramos de un mismo producto (uno por almacén) como una sola línea', async () => {
    const { servicio } = armar({ pedido: { items: [lineaPedido(1, 5, 3, 1), lineaPedido(2, 5, 2, 2)] } });

    const pedido = await servicio.obtener(57);

    expect(pedido.items).toHaveLength(1);
    expect(pedido.items[0]).toMatchObject({ id_producto: 5, cantidad: 5, total: 50 });
    expect(pedido.cantidad_items).toBe(5);
  });
});
