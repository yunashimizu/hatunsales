import { Logger } from '@nestjs/common';
import { OyentesEnvioFiscal } from '../../sunat/emision/emision.contrato';
import type { EventoEnvioCompletado } from '../../sunat/emision/emision.contrato';
import { EfectosNotasTarea } from './efectos-notas.tarea';

function montar() {
  const notas = {
    aplicarEfectos: jest.fn(async (idNota: number) => ({ id_nota: idNota })),
    notasConEfectosPendientes: jest.fn(async () => [70, 71, 72]),
  };
  const oyentes = new OyentesEnvioFiscal();
  const config = { tareasActivas: jest.fn(async () => true) };
  const tarea = new EfectosNotasTarea(notas as never, oyentes, config as never);
  return { tarea, notas, oyentes, config };
}

function evento(parcial: Partial<EventoEnvioCompletado> = {}): EventoEnvioCompletado {
  return { id_envio: 600, id_comprobante: 70, ambiente: 'produccion', tipo_documento: '07', estado: 'ACEPTADO', aceptado: true, origen: 'envio', ...parcial };
}

describe('EfectosNotasTarea (efectos de las notas de crédito cuando SUNAT las acepta)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('se registra como oyente de los envíos y aplica los efectos al instante solo de una nota ACEPTADA', async () => {
    const { tarea, notas, oyentes } = montar();
    tarea.onModuleInit();

    await oyentes.notificar(evento());
    await oyentes.notificar(evento({ id_comprobante: 71, estado: 'ACEPTADO_OBS' }));
    expect(notas.aplicarEfectos.mock.calls.map((c) => c[0])).toEqual([70, 71]);

    // Rechazada, en reintento, de otro tipo o sin comprobante: no aplica nada (la rechazada queda visible en Documentos).
    await oyentes.notificar(evento({ estado: 'RECHAZADO', aceptado: false }));
    await oyentes.notificar(evento({ estado: 'PENDIENTE_REENVIO', aceptado: false }));
    await oyentes.notificar(evento({ tipo_documento: '01' }));
    await oyentes.notificar(evento({ id_comprobante: null }));
    expect(notas.aplicarEfectos).toHaveBeenCalledTimes(2);
  });

  it('el oyente nunca lanza: si los efectos fallan, lo registra y queda para el barrido', async () => {
    const { tarea, notas } = montar();
    notas.aplicarEfectos.mockRejectedValueOnce(new Error('deadlock detected'));
    const error = jest.spyOn(Logger.prototype, 'error');

    await expect(tarea.alCompletarEnvio(evento())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('El barrido lo reintentará'));
  });

  it('el barrido corre solo con las tareas programadas activas', async () => {
    const { tarea, notas, config } = montar();
    config.tareasActivas.mockResolvedValueOnce(false);

    expect(await tarea.ejecutar()).toBe(0);
    expect(notas.notasConEfectosPendientes).not.toHaveBeenCalled();
    expect(notas.aplicarEfectos).not.toHaveBeenCalled();
  });

  it('idempotente: cuenta solo las que aplicó (el oyente u otra réplica ya tomaron las demás) y un fallo no frena al resto', async () => {
    const { tarea, notas } = montar();
    notas.aplicarEfectos
      .mockResolvedValueOnce(null as never)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ id_nota: 72 });

    expect(await tarea.ejecutar()).toBe(1);
    expect(notas.notasConEfectosPendientes).toHaveBeenCalledWith(EfectosNotasTarea.NOTAS_POR_VUELTA);
    expect(notas.aplicarEfectos.mock.calls.map((c) => c[0])).toEqual([70, 71, 72]);
  });

  it('no se superpone consigo misma (una vuelta a la vez) y un error de la BD no la detiene', async () => {
    const { tarea, notas } = montar();
    let liberar: (ids: number[]) => void = () => undefined;
    notas.notasConEfectosPendientes.mockReturnValueOnce(new Promise<number[]>((resolve) => (liberar = resolve)));
    const primera = tarea.ejecutar();
    expect(await tarea.ejecutar()).toBe(0);
    liberar([]);
    expect(await primera).toBe(0);

    notas.notasConEfectosPendientes.mockRejectedValueOnce(new Error('conexión cerrada'));
    expect(await tarea.ejecutar()).toBe(0);
    expect(await tarea.ejecutar()).toBe(3);
  });

  it('programa la primera vuelta con retraso y apaga sus temporizadores al cerrar el módulo', () => {
    jest.useFakeTimers();
    try {
      const { tarea, config } = montar();
      tarea.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(2);
      tarea.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(EfectosNotasTarea.INTERVALO_MS * 2);
      expect(config.tareasActivas).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
