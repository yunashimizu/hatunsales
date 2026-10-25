import { BadRequestException } from '@nestjs/common';
import { CheckoutBussnies } from './checkout.bussnies';

function cupon(parcial: Record<string, unknown> = {}) {
  return {
    id_cupon: 1,
    codigo: 'FERRE10',
    tipo: 'porcentaje',
    valor: '10',
    minimo_compra: '0',
    usos_maximos: null,
    usos_actuales: 0,
    fecha_inicio: null,
    fecha_fin: null,
    activo: true,
    ...parcial,
  };
}

function armar(opciones: { cupon?: any; metodoEnvio?: any; metodoPago?: any } = {}) {
  const repo = {
    buscarCupon: jest.fn(async () => opciones.cupon ?? null),
    obtenerMetodoEnvio: jest.fn(async () => opciones.metodoEnvio ?? null),
    obtenerMetodoPago: jest.fn(async () => opciones.metodoPago ?? null),
  };
  return { servicio: new CheckoutBussnies(repo as any), repo };
}

/**
 * 20:30 del 21/10 en Lima (ya es 22/10 en UTC). Las fechas de Lima no dependen
 * de la zona del proceso: con `TZ=UTC npx jest` se reproduce Railway.
 */
const NOCHE_EN_LIMA = new Date('2026-10-22T01:30:00Z');

describe('CheckoutBussnies · vigencia del cupón en días de Lima (E16)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOCHE_EN_LIMA, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('un cupón que vence hoy sigue valiendo por la noche en Lima', async () => {
    const { servicio } = armar({ cupon: cupon({ fecha_fin: '2026-10-21' }) });

    const aplicado = await servicio.validarCupon('ferre10', 200);

    expect(aplicado.descuento).toBe(20);
  });

  it('un cupón que empieza mañana todavía no vale aunque en UTC ya sea mañana', async () => {
    const { servicio } = armar({ cupon: cupon({ fecha_inicio: '2026-10-22' }) });

    await expect(servicio.validarCupon('FERRE10', 200)).rejects.toThrow('todavía no está vigente');
  });

  it('un cupón que venció ayer ya no vale', async () => {
    const { servicio } = armar({ cupon: cupon({ fecha_fin: '2026-10-20' }) });

    await expect(servicio.validarCupon('FERRE10', 200)).rejects.toThrow('ya venció');
  });

  it('acepta también fechas que lleguen como Date (columna date leída a medianoche)', async () => {
    const { servicio } = armar({ cupon: cupon({ fecha_inicio: new Date(2026, 9, 21), fecha_fin: new Date(2026, 9, 21) }) });

    await expect(servicio.validarCupon('FERRE10', 200)).resolves.toMatchObject({ descuento: 20 });
  });

  it('pide el código si llega vacío', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.validarCupon('   ', 200)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.buscarCupon).not.toHaveBeenCalled();
  });
});

describe('CheckoutBussnies · métodos del pedido (E04)', () => {
  it('no acepta un método de envío desactivado', async () => {
    const { servicio } = armar({ metodoEnvio: { id_metodo_envio: 2, costo: '15', activo: false } });

    await expect(servicio.costoEnvio(2)).rejects.toThrow('no está disponible');
  });

  it('devuelve el costo de un método de envío activo', async () => {
    const { servicio } = armar({ metodoEnvio: { id_metodo_envio: 2, costo: '15.50', activo: true } });

    await expect(servicio.costoEnvio(2)).resolves.toBe(15.5);
  });

  it.each([
    ['inexistente', null],
    ['desactivado', { id_metodo: 4, activo: false }],
  ])('no acepta un método de pago %s', async (_caso, metodo) => {
    const { servicio } = armar({ metodoPago: metodo });

    await expect(servicio.validarMetodoPago(4)).rejects.toThrow('no está disponible');
  });

  it('acepta un método de pago activo', async () => {
    const { servicio } = armar({ metodoPago: { id_metodo: 4, activo: true } });

    await expect(servicio.validarMetodoPago(4)).resolves.toBeUndefined();
  });
});
