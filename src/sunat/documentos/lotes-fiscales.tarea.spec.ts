import { Logger } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import type { EmisionDirecta, ModoEmision } from '../emision/emision.contrato';
import type { LoteFiscalRepository } from './lote-fiscal.repository';
import { LotesFiscalesService } from './lotes-fiscales.service';
import { LotesFiscalesTarea } from './lotes-fiscales.tarea';

/** Lotes compartidos por varias instancias: cada lote solo se puede reclamar una vez (lease por fila). */
class ColaCompartida {
  readonly reclamados = new Set<number>();
  readonly procesadosPor: Array<{ instancia: string; id: number }> = [];

  lotesDe(instancia: string) {
    return {
      reintentar: jest.fn(async (id: number, origen: string) => {
        expect(origen).toBe('tarea');
        // Simula el UPDATE condicionado del reclamo: el segundo que llega no obtiene la fila.
        if (this.reclamados.has(id)) throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'Otro proceso está enviando este lote.');
        this.reclamados.add(id);
        await Promise.resolve();
        this.procesadosPor.push({ instancia, id });
        return { id_envio: id };
      }),
    };
  }
}

function crear(opciones: {
  activas?: boolean;
  modo?: ModoEmision;
  candidatos?: number[];
  lotes?: { reintentar: jest.Mock };
} = {}) {
  const config = { tareasActivas: jest.fn(async () => opciones.activas ?? true) };
  const emisionDirecta = { modo: jest.fn(async () => opciones.modo ?? ({ activo: true, ambiente: 'produccion' } as ModoEmision)) };
  const lotes = opciones.lotes ?? { reintentar: jest.fn(async (id: number) => ({ id_envio: id })) };
  const repositorio = { candidatosTarea: jest.fn(async () => [...(opciones.candidatos ?? [])]) };
  const tarea = new LotesFiscalesTarea(
    config as unknown as FiscalConfigService,
    emisionDirecta as unknown as EmisionDirecta,
    lotes as unknown as LotesFiscalesService,
    repositorio as unknown as LoteFiscalRepository,
  );
  return { tarea, config, emisionDirecta, lotes, repositorio };
}

describe('LotesFiscalesTarea (bajas RA y resúmenes RC: tickets y reenvíos)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('no corre con las tareas apagadas ni con la emisión inactiva (interruptor, BETA apagada…)', async () => {
    const apagada = crear({ activas: false, candidatos: [1] });
    expect(await apagada.tarea.ejecutar()).toBe(0);
    expect(apagada.repositorio.candidatosTarea).not.toHaveBeenCalled();

    const detenida = crear({
      modo: { activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_BLOQUEADA', motivo: 'Clave SOL rechazada.' },
      candidatos: [1],
    });
    expect(await detenida.tarea.ejecutar()).toBe(0);
    expect(detenida.repositorio.candidatosTarea).not.toHaveBeenCalled();
    expect(detenida.lotes.reintentar).not.toHaveBeenCalled();
  });

  it('toma hasta 10 lotes del ambiente VIGENTE y los procesa por el mismo camino del reintento (origen «tarea»)', async () => {
    const { tarea, repositorio, lotes } = crear({ modo: { activo: true, ambiente: 'beta' }, candidatos: [4, 9] });

    expect(await tarea.ejecutar()).toBe(2);

    expect(repositorio.candidatosTarea).toHaveBeenCalledWith('beta', 10);
    expect(lotes.reintentar.mock.calls).toEqual([
      [4, 'tarea'],
      [9, 'tarea'],
    ]);
  });

  it('dos instancias a la vez: cada lote se procesa una sola vez (el reclamo por fila decide)', async () => {
    const cola = new ColaCompartida();
    const a = crear({ candidatos: [1, 2, 3, 4], lotes: cola.lotesDe('A') });
    const b = crear({ candidatos: [1, 2, 3, 4], lotes: cola.lotesDe('B') });

    const [procesadosA, procesadosB] = await Promise.all([a.tarea.ejecutar(), b.tarea.ejecutar()]);

    expect(procesadosA + procesadosB).toBe(4);
    expect(cola.procesadosPor.map((p) => p.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('una vuelta no se solapa con la anterior (enCurso)', async () => {
    let liberar: () => void = () => undefined;
    const lenta = { reintentar: jest.fn(() => new Promise((resolver) => (liberar = () => resolver({})))) };
    const { tarea } = crear({ candidatos: [1], lotes: lenta });
    const primera = tarea.ejecutar();
    await new Promise((r) => setImmediate(r));

    expect(await tarea.ejecutar()).toBe(0);
    liberar();
    expect(await primera).toBe(1);
  });

  it('si SUNAT detiene la emisión a mitad de la vuelta corta; lo tomado por otro o ya resuelto se salta; un error suelto no corta', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const lotes = {
      reintentar: jest
        .fn()
        .mockRejectedValueOnce(new Error('BD lenta'))
        .mockRejectedValueOnce(new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'otro proceso'))
        .mockRejectedValueOnce(new FiscalConfigError('FISCAL_REENVIO_NO_PERMITIDO', 'ya resuelto'))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new FiscalConfigError('FISCAL_EMISION_BLOQUEADA', 'detenida'))
        .mockResolvedValue({}),
    };
    const { tarea } = crear({ candidatos: [1, 2, 3, 4, 5, 6, 7], lotes });

    expect(await tarea.ejecutar()).toBe(1);
    expect(lotes.reintentar).toHaveBeenCalledTimes(5);
  });

  it('un error de la BD al buscar candidatos no la detiene: la vuelta termina en 0 y la siguiente funciona', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { tarea, repositorio } = crear({ candidatos: [3] });
    repositorio.candidatosTarea.mockRejectedValueOnce(new Error('conexión cerrada'));

    expect(await tarea.ejecutar()).toBe(0);
    expect(await tarea.ejecutar()).toBe(1);
  });

  it('programa la vuelta cada 2 minutos con un retraso inicial al azar y limpia los temporizadores al cerrar', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const { tarea, config } = crear({ candidatos: [] });

    tarea.onApplicationBootstrap();
    jest.advanceTimersByTime(89_000);
    expect(config.tareasActivas).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(config.tareasActivas).toHaveBeenCalledTimes(1);

    tarea.onModuleDestroy();
    jest.advanceTimersByTime(10 * 60_000);
    expect(config.tareasActivas).toHaveBeenCalledTimes(1);
  });
});
