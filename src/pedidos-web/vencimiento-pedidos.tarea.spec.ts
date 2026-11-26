import { Logger } from '@nestjs/common';
import { intervaloVencimientoPedidosMs, VencimientoPedidosTarea } from './vencimiento-pedidos.tarea';

describe('VencimientoPedidosTarea (Fase 8.2, D5)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  function armar(horas: { pasarela: number; transferencia: number }, candidatos = [
    { id_pedido: 57, clase: 'transferencia', horas: 48 },
    { id_pedido: 58, clase: 'pasarela', horas: 24 },
  ]) {
    const repo = { pedidosVencidos: jest.fn(async () => candidatos) };
    const pedidos = {
      // El 58 ya no estaba pendiente cuando llegó su turno (lo pagaron o lo venció otra réplica).
      vencer: jest.fn(async (id: number) => (id === 58 ? null : { stock_devuelto: true, cupon_devuelto: true, id_cupon: 8 })),
    };
    const control = { horasVencimiento: jest.fn(async () => horas) };
    const bitacora = { registrarCon: jest.fn(async () => undefined) };
    const tarea = new VencimientoPedidosTarea(repo as never, pedidos as never, control as never, bitacora as never);
    return { tarea, repo, pedidos, bitacora };
  }

  it('apagada por defecto (0 h y 0 h): no busca pedidos ni cancela nada', async () => {
    const { tarea, repo, pedidos } = armar({ pasarela: 0, transferencia: 0 });
    expect(await tarea.ejecutar()).toBe(0);
    expect(repo.pedidosVencidos).not.toHaveBeenCalled();
    expect(pedidos.vencer).not.toHaveBeenCalled();
  });

  it('encendida: vence con las horas de su clase; un pedido que ya cambió (null) no cuenta ni se anota', async () => {
    const { tarea, repo, pedidos, bitacora } = armar({ pasarela: 24, transferencia: 48 });

    expect(await tarea.ejecutar()).toBe(1);

    expect(repo.pedidosVencidos).toHaveBeenCalledWith({ pasarela: 24, transferencia: 48 }, 50);
    expect(pedidos.vencer).toHaveBeenCalledWith(57, 48);
    expect(pedidos.vencer).toHaveBeenCalledWith(58, 24);
    expect(bitacora.registrarCon).toHaveBeenCalledTimes(1);
    const evento = (bitacora.registrarCon.mock.calls[0] as any[])[0]();
    expect(evento).toMatchObject({
      accion: 'pedido.vencido', entidad: 'pedido', id_entidad: 57,
      despues: { horas: 48, clase: 'transferencia', stock_devuelto: true, cupon_devuelto: true },
    });
  });

  it('un pedido que falla no frena a los demás; un fallo general no lanza; dos vueltas a la vez no se pisan', async () => {
    const { tarea, pedidos, repo } = armar({ pasarela: 24, transferencia: 0 }, [
      { id_pedido: 1, clase: 'pasarela', horas: 24 }, { id_pedido: 2, clase: 'pasarela', horas: 24 },
    ] as any);
    pedidos.vencer.mockRejectedValueOnce(new Error('candado'));
    expect(await tarea.ejecutar()).toBe(1);
    repo.pedidosVencidos.mockRejectedValueOnce(new Error('sin base'));
    expect(await tarea.ejecutar()).toBe(0);
    const [a, b] = await Promise.all([tarea.ejecutar(), tarea.ejecutar()]);
    expect(a + b).toBe(2);
    expect(repo.pedidosVencidos).toHaveBeenCalledTimes(3);
  });

  it('intervalo: 15 min por defecto, 0 apaga el temporizador, mínimo 5', () => {
    expect(intervaloVencimientoPedidosMs(undefined)).toBe(15 * 60_000);
    expect(intervaloVencimientoPedidosMs('0')).toBe(0);
    expect(intervaloVencimientoPedidosMs('1')).toBe(5 * 60_000);
  });
});
