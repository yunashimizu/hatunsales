import { BadRequestException } from '@nestjs/common';
import { PagoBussnies } from './pago.bussnies';
import { PasarelaSimulada } from '../../../util/pasarela/simulada.pasarela';

/**
 * Cobro de pedidos web con la pasarela simulada (la que está activa mientras no
 * haya llaves de Culqi). Los casos reproducen los ataques de la auditoría del
 * 21/10: pagar sin token y llamar al webhook público sin firma.
 */

type Estado = 'pendiente' | 'pagado' | 'preparando' | 'enviado' | 'entregado' | 'cancelado';

function escenario(opciones: { estado?: Estado; total?: number } = {}) {
  const pedidos = new Map<number, any>();
  const crearPedido = (id: number, estado: Estado) =>
    pedidos.set(id, {
      id_pedido: id,
      codigo: `PED-20261021-${String(id).padStart(4, '0')}`,
      estado,
      total: String(opciones.total ?? 118),
      cliente: { id_cliente: 3, email: 'cliente@correo.pe' },
      metodo_pago: { id_metodo: 7 },
    });
  crearPedido(7, opciones.estado ?? 'pendiente');
  crearPedido(8, 'pendiente');

  const pagos: any[] = [];
  const eventos: any[] = [];
  const historial: { id: number; estado: string }[] = [];

  const repo = {
    obtenerPorId: jest.fn(async (id: number) => (pedidos.has(id) ? { ...pedidos.get(id) } : null)),
    buscarPagoPorClave: jest.fn(async (id: number, clave: string) =>
      pagos.find((p) => p.idPedido === id && p.clave_idempotencia === clave) ?? null),
    buscarPagoPorReferenciaExterna: jest.fn(async (proveedor: string, referencia: string) => {
      const pago = pagos.find((p) => p.proveedor === proveedor && p.referencia_externa === referencia);
      return pago ? { ...pago, pedido: { id_pedido: pago.idPedido } } : null;
    }),
    registrarPago: jest.fn(async (datos: any) => {
      pagos.push(datos);
      return datos;
    }),
    registrarEstado: jest.fn(async (id: number, estado: string) => {
      historial.push({ id, estado });
    }),
    // Cambio de estado sin condición (código anterior a la corrección).
    cambiarEstado: jest.fn(async (id: number, estado: string) => {
      pedidos.get(id).estado = estado;
    }),
    // Cambio condicional 'pendiente' → 'pagado' con su cobro, todo o nada.
    confirmarPago: jest.fn(async (id: number, _comentario: string, pago?: any) => {
      const pedido = pedidos.get(id);
      if (!pedido || pedido.estado !== 'pendiente') return false;
      pedido.estado = 'pagado';
      historial.push({ id, estado: 'pagado' });
      if (pago) pagos.push(pago);
      return true;
    }),
    registrarEventoPasarela: jest.fn(async (evento: any) => {
      eventos.push({ ...evento });
      return eventos.length;
    }),
    cerrarEventoPasarela: jest.fn(async (ref: { idEvento?: number }, resultado: any) => {
      if (ref.idEvento) Object.assign(eventos[ref.idEvento - 1], resultado);
    }),
    marcarEventoProcesado: jest.fn(async () => undefined),
  };

  const ventaRepo = { generarDesdePedido: jest.fn(async () => 99) };
  const stockRepo = { configuracion: jest.fn(async () => 'pagado') };
  const pedidosBussnies = { obtener: jest.fn(async (id: number) => ({ ...pedidos.get(id) })) };
  const pasarela = new PasarelaSimulada();
  const cargo = jest.spyOn(pasarela, 'crearCargo');

  const servicio = new PagoBussnies(
    repo as any,
    ventaRepo as any,
    stockRepo as any,
    pedidosBussnies as any,
    pasarela,
  );

  return { servicio, repo, ventaRepo, pedidos, pagos, eventos, historial, cargo };
}

const ENTORNO_ORIGINAL = { ...process.env };

function enProduccion(): void {
  process.env.NODE_ENV = 'production';
}

function enDesarrollo(): void {
  process.env.NODE_ENV = 'development';
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
}

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe('PagoBussnies · pago sin token (E01)', () => {
  it.each([
    ['producción', enProduccion],
    ['desarrollo', enDesarrollo],
  ])('en %s un pago sin token queda pendiente de confirmación manual y no genera venta', async (_nombre, entorno) => {
    entorno();
    const { servicio, pedidos, pagos, cargo, ventaRepo } = escenario();

    const respuesta = await servicio.pagar(7, { id_metodo: 7 }, 3);

    expect(respuesta.estado).toBe('pendiente');
    expect(pedidos.get(7).estado).toBe('pendiente');
    expect(cargo).not.toHaveBeenCalled();
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({ idPedido: 7, estado: 'pendiente', proveedor: 'manual' });
  });

  it('en producción la pasarela simulada no aprueba un cargo aunque llegue un token inventado', async () => {
    enProduccion();
    const { servicio, pedidos, pagos, ventaRepo } = escenario();

    await expect(servicio.pagar(7, { token_pasarela: 'tok_inventado' }, 3)).rejects.toBeInstanceOf(BadRequestException);

    expect(pedidos.get(7).estado).toBe('pendiente');
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(pagos.every((p) => p.estado !== 'aprobado')).toBe(true);
  });

  it('en desarrollo la simulada sigue aprobando un cargo con token para probar de punta a punta', async () => {
    enDesarrollo();
    const { servicio, pedidos, ventaRepo } = escenario();

    await servicio.pagar(7, { token_pasarela: 'tok_prueba' }, 3);

    expect(pedidos.get(7).estado).toBe('pagado');
    expect(ventaRepo.generarDesdePedido).toHaveBeenCalledTimes(1);
  });

  it('un pedido de otro cliente responde como inexistente', async () => {
    enDesarrollo();
    const { servicio } = escenario();
    await expect(servicio.pagar(7, {}, 999)).rejects.toThrow('no encontrado');
  });
});

describe('PagoBussnies · webhook público (E02)', () => {
  it('en producción un webhook de la simulada (sin firma) no toca el pedido ni genera venta', async () => {
    enProduccion();
    const { servicio, pedidos, pagos, eventos, ventaRepo } = escenario();

    const respuesta = await servicio.procesarWebhook({ metadata: { id_pedido: 7 } }, {});

    expect(respuesta).toEqual({ recibido: true });
    expect(pedidos.get(7).estado).toBe('pendiente');
    expect(pagos).toHaveLength(0);
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(eventos[0].error).toBeTruthy();
  });

  it('un evento válido no revive un pedido cancelado: queda anotado para revisar la devolución', async () => {
    enDesarrollo();
    const { servicio, pedidos, pagos, eventos, ventaRepo } = escenario({ estado: 'cancelado' });

    await servicio.procesarWebhook({ referencia: 'ch_1', monto: 118, metadata: { id_pedido: 7 } }, {});

    expect(pedidos.get(7).estado).toBe('cancelado');
    expect(pagos).toHaveLength(0);
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(eventos[0].procesado).toBe(false);
    expect(eventos[0].error).toMatch(/cancelado/i);
  });

  it('no confirma si el monto cobrado no coincide con el total del pedido', async () => {
    enDesarrollo();
    const { servicio, pedidos, pagos, eventos, ventaRepo } = escenario({ total: 118 });

    await servicio.procesarWebhook({ referencia: 'ch_2', monto: 1, metadata: { id_pedido: 7 } }, {});

    expect(pedidos.get(7).estado).toBe('pendiente');
    expect(pagos).toHaveLength(0);
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(eventos[0].error).toMatch(/monto/i);
  });

  it('con firma y monto correctos confirma una sola vez aunque la pasarela reintente', async () => {
    enDesarrollo();
    const { servicio, pedidos, pagos, ventaRepo } = escenario({ total: 118 });
    const cuerpo = { referencia: 'ch_3', monto: 118, metadata: { id_pedido: 7 } };

    await servicio.procesarWebhook(cuerpo, {});
    await servicio.procesarWebhook(cuerpo, {});

    expect(pedidos.get(7).estado).toBe('pagado');
    expect(pagos.filter((p) => p.estado === 'aprobado')).toHaveLength(1);
    expect(ventaRepo.generarDesdePedido).toHaveBeenCalledTimes(1);
  });

  it('la referencia de un cargo ya registrado confirma el pedido de ESE cargo, no el que diga la metadata', async () => {
    enDesarrollo();
    const { servicio, pedidos, pagos } = escenario({ estado: 'pagado' });
    pagos.push({ idPedido: 7, proveedor: 'simulada', referencia_externa: 'ch_4', estado: 'aprobado' });

    await servicio.procesarWebhook({ referencia: 'ch_4', monto: 118, metadata: { id_pedido: 8 } }, {});

    expect(pedidos.get(8).estado).toBe('pendiente');
  });

  it('si otro proceso movió el pedido entre la lectura y la confirmación, no se genera venta', async () => {
    enDesarrollo();
    const { servicio, repo, ventaRepo, eventos } = escenario();
    repo.confirmarPago.mockResolvedValueOnce(false);

    await servicio.procesarWebhook({ referencia: 'ch_5', monto: 118, metadata: { id_pedido: 7 } }, {});

    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
    expect(eventos[0].procesado).toBe(false);
    expect(eventos[0].error).toBeTruthy();
  });
});

describe('PagoBussnies · confirmación manual', () => {
  it('no confirma un pedido cancelado', async () => {
    enDesarrollo();
    const { servicio, pedidos, ventaRepo } = escenario({ estado: 'cancelado' });

    await expect(servicio.confirmarManual(7, 'OP-123')).rejects.toBeInstanceOf(BadRequestException);

    expect(pedidos.get(7).estado).toBe('cancelado');
    expect(ventaRepo.generarDesdePedido).not.toHaveBeenCalled();
  });

  it('confirma un pedido pendiente: registra el cobro manual y genera la venta', async () => {
    enProduccion();
    const { servicio, pedidos, pagos, ventaRepo } = escenario();

    await servicio.confirmarManual(7, 'OP-123');

    expect(pedidos.get(7).estado).toBe('pagado');
    expect(pagos).toEqual([expect.objectContaining({ idPedido: 7, estado: 'aprobado', proveedor: 'manual', referencia: 'OP-123' })]);
    expect(ventaRepo.generarDesdePedido).toHaveBeenCalledTimes(1);
  });
});
