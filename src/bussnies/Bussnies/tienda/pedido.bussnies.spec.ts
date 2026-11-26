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
    devolverUso: jest.fn(async () => true),
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

describe('PedidoBussnies · resumen por preparar', () => {
  it('delega el conteo en el repositorio y suma el total, sin traer las listas', async () => {
    const { servicio, repo } = armar();
    const contarPorPreparar = jest.fn(async () => ({ pendientes: 2, pagados: 3 }));
    const listarTodos = jest.fn();
    Object.assign(repo, { contarPorPreparar, listarTodos });

    await expect(servicio.resumenPorPreparar()).resolves.toEqual({ pendientes: 2, pagados: 3, total: 5 });
    expect(contarPorPreparar).toHaveBeenCalledTimes(1);
    expect(listarTodos).not.toHaveBeenCalled();
  });
});

describe('PedidoBussnies · comprobante en el detalle (S5)', () => {
  function conComprobante(resumenDe: jest.Mock) {
    const base = armar({ pedido: { estado: 'pagado' } });
    const servicio = new PedidoBussnies(
      base.servicio['repo'], base.servicio['carritoRepo'], base.servicio['carritoBussnies'], base.servicio['checkoutBussnies'],
      base.servicio['stockRepo'], base.servicio['dataSource'], base.servicio['cuentaRepo'], { resumenDe } as any,
    );
    return servicio;
  }

  it('el panel recibe el comprobante con el motivo; el comprador y los pagos no', async () => {
    const resumenDe = jest.fn(async (_pedido: any, paraPersonal: boolean) => ({ estado: 'sin_comprobante', puede_descargar: false, ...(paraPersonal ? { motivo: 'x' } : {}) }));
    const servicio = conComprobante(resumenDe);

    const panel = await servicio.obtener(57, undefined, true);
    const comprador = await servicio.obtener(57, 3);
    const interno = await servicio.obtener(57);

    expect(panel.comprobante).toMatchObject({ motivo: 'x' });
    expect(comprador.comprobante?.motivo).toBeUndefined();
    expect(interno.comprobante?.motivo).toBeUndefined();
    expect(resumenDe.mock.calls.map((c) => c[1])).toEqual([true, false, false]);
  });

  it('si no se puede leer el comprobante, el pedido sale igual sin esa sección', async () => {
    const servicio = conComprobante(jest.fn(async () => { throw new Error('sin tabla'); }));

    const pedido = await servicio.obtener(57, undefined, true);

    expect(pedido.codigo).toBeDefined();
    expect(pedido.comprobante).toBeUndefined();
  });
});

/**
 * Fase 8.2: la base simulada imita lo que garantiza PostgreSQL: el UPDATE condicional de `transicionarEstado`
 * es atómico (solo uno encuentra el pedido en `desde`) y lo que corre en la transacción se aplica todo junto.
 * Las esperas (`tick`) dejan que las operaciones simultáneas se entrecrucen.
 */
describe('PedidoBussnies · vencimiento y cancelación: el stock y el cupón vuelven exactamente una vez (Fase 8.2)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function baseSimulada(opciones: { conCupon?: boolean; pagos?: string[] } = {}) {
    const bd = {
      estado: 'pendiente',
      stock_reservado: true,
      id_venta: null as number | null,
      id_cupon: opciones.conCupon === false ? null : 8,
      stock: 0,
      usos_cupon: 1,
      pagos: [...(opciones.pagos ?? [])],
      historial: [] as string[],
    };
    const armado = armar({ pedido: { estado: 'pendiente' } });
    (armado.repo.transicionarEstado as jest.Mock).mockImplementation(async (_id: number, desde: readonly string[], hacia: string, comentario?: string, _m?: any, op: any = {}) => {
      await tick();
      if (!desde.includes(bd.estado)) return null;
      if (op.sinPagoEnCurso && bd.pagos.some((p) => p === 'pendiente' || p === 'aprobado')) return null;
      bd.estado = hacia;
      bd.historial.push(`${hacia}: ${comentario ?? ''}`);
      return { id_pedido: 57, stock_reservado: bd.stock_reservado, id_venta: bd.id_venta, id_cupon: bd.id_cupon };
    });
    (armado.repo.marcarStockReservado as jest.Mock).mockImplementation(async (_id: number, reservado: boolean) => {
      bd.stock_reservado = reservado;
    });
    armado.repo.obtenerPorId.mockImplementation(async () => pedidoBase({ estado: bd.estado }));
    armado.stockRepo.devolver.mockImplementation(async () => {
      await tick();
      bd.stock += 5;
    });
    armado.checkoutBussnies.devolverUso.mockImplementation(async () => {
      if (bd.usos_cupon <= 0) return false;
      bd.usos_cupon -= 1;
      return true;
    });
    /** Lo que hace PedidoRepository.confirmarPago: 'pendiente' → 'pagado' condicional, con su cobro. */
    const confirmarPago = async () => {
      const cambio = await (armado.repo.transicionarEstado as jest.Mock)(57, ['pendiente'], 'pagado', 'Pago confirmado');
      if (cambio) bd.pagos.push('aprobado');
      return cambio !== null;
    };
    return { ...armado, bd, confirmarPago };
  }

  it('vencer: cancela con la nota de las horas, devuelve el stock y el uso del cupón, y exige que no haya cobro en curso', async () => {
    const { servicio, repo, bd, manager } = baseSimulada();

    const resultado = await servicio.vencer(57, 24);

    expect(resultado).toEqual({ stock_devuelto: true, cupon_devuelto: true, id_cupon: 8 });
    expect(repo.transicionarEstado).toHaveBeenCalledWith(
      57, ['pendiente'], 'cancelado', 'Vencido automáticamente: sin pago en 24 h', manager, { sinVentaVigente: true, sinPagoEnCurso: true },
    );
    expect(bd).toMatchObject({ estado: 'cancelado', stock: 5, usos_cupon: 0, stock_reservado: false });
    expect(bd.historial).toEqual(['cancelado: Vencido automáticamente: sin pago en 24 h']);
  });

  it('se cancela dos veces a la vez (la tarea en dos réplicas, o la tarea y el cliente): el stock y el cupón vuelven UNA vez', async () => {
    const { servicio, bd } = baseSimulada();

    const resultados = await Promise.all([servicio.vencer(57, 24), servicio.vencer(57, 24), servicio.cancelar(57, 3, 'Ya no lo quiero')]);

    expect(bd.stock).toBe(5);
    expect(bd.usos_cupon).toBe(0);
    expect(bd.historial).toHaveLength(1);
    // De los dos vencimientos, a lo sumo uno ganó; el otro recibe null y no toca nada.
    expect(resultados.slice(0, 2).filter((r) => r !== null).length).toBeLessThanOrEqual(1);
  });

  it('la tarea vence el pedido mientras llega el pago: gana uno solo y el stock se libera como mucho una vez', async () => {
    for (let ronda = 0; ronda < 6; ronda++) {
      const { servicio, bd, confirmarPago } = baseSimulada();
      // Alterna quién arranca primero para cubrir los dos órdenes.
      const [vencido, pagado] = ronda % 2
        ? await Promise.all([servicio.vencer(57, 24), confirmarPago()])
        : await Promise.all([confirmarPago(), servicio.vencer(57, 24)]).then(([p, v]) => [v, p] as const);

      expect((vencido !== null) !== pagado).toBe(true);
      if (pagado) {
        expect(bd).toMatchObject({ estado: 'pagado', stock: 0, usos_cupon: 1, stock_reservado: true });
      } else {
        // El cargo que llegue después ya no confirma: lo maneja la Fase 8.3 (cobro sobre pedido cancelado).
        expect(bd).toMatchObject({ estado: 'cancelado', stock: 5, usos_cupon: 0, stock_reservado: false });
        expect(await confirmarPago()).toBe(false);
        expect(bd.stock).toBe(5);
      }
    }
  });

  it('un pedido con un pago manual pendiente de confirmar (o aprobado) no se vence', async () => {
    for (const pago of ['pendiente', 'aprobado']) {
      const { servicio, bd } = baseSimulada({ pagos: [pago] });
      expect(await servicio.vencer(57, 48)).toBeNull();
      expect(bd).toMatchObject({ estado: 'pendiente', stock: 0, usos_cupon: 1 });
    }
    // Un pago rechazado no frena el vencimiento.
    const rechazado = baseSimulada({ pagos: ['rechazado'] });
    expect(await rechazado.servicio.vencer(57, 48)).not.toBeNull();
  });

  it('la cancelación manual del panel y la del cliente también devuelven el uso del cupón (antes solo se sumaba)', async () => {
    const panel = baseSimulada();
    await panel.servicio.cambiarEstado(57, 'cancelado', 'Sin stock real');
    expect(panel.checkoutBussnies.devolverUso).toHaveBeenCalledWith(8, panel.manager);
    expect(panel.bd.usos_cupon).toBe(0);

    const cliente = baseSimulada();
    await cliente.servicio.cancelar(57, 3);
    expect(cliente.bd.usos_cupon).toBe(0);

    const sinCupon = baseSimulada({ conCupon: false });
    await sinCupon.servicio.cancelar(57, 3);
    expect(sinCupon.checkoutBussnies.devolverUso).not.toHaveBeenCalled();
  });

  it('pedido con venta (ya anulada): la cancelación no devuelve stock (lo devolvió la anulación) pero sí el cupón', async () => {
    const { servicio, bd } = baseSimulada();
    bd.id_venta = 99;

    const resultado = await servicio.vencer(57, 24);

    expect(resultado).toEqual({ stock_devuelto: false, cupon_devuelto: true, id_cupon: 8 });
    expect(bd.stock).toBe(0);
  });

  it('el checkout reserva el stock con el pedido como documento de origen (8.1)', async () => {
    const { servicio, stockRepo, manager } = armar();

    await servicio.crearDesdeCarrito(3, {} as any);

    expect(stockRepo.reservar).toHaveBeenCalledWith(
      [{ id_producto: 5, cantidad: 5 }], undefined, 'spillover', manager, { tipo_documento: 'pedido', id_documento: 57 },
    );
  });
});
