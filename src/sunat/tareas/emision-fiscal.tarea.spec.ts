import { Logger } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { EmisionDirecta, ModoEmision } from '../emision/emision.contrato';
import type { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import type { SunatEmisionService } from '../emision/sunat-emision.service';
import { EmisionFiscalTarea } from './emision-fiscal.tarea';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-10-21T15:00:00Z');
  }
}

/** Fiscal_envios compartido por varias instancias: cada envío solo se puede reclamar una vez (lease). */
class ColaCompartida {
  readonly reclamados = new Set<number>();
  readonly procesadosPor: Array<{ instancia: string; id: number }> = [];

  constructor(public pendientes: number[]) {}

  emisionDe(instancia: string) {
    return {
      reintentar: jest.fn(async (id: number, origen: string) => {
        expect(origen).toBe('tarea');
        // Simula el UPDATE … FOR UPDATE SKIP LOCKED: el segundo que llega no obtiene la fila.
        if (this.reclamados.has(id)) throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'Otro proceso está enviando este comprobante.');
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
  emision?: { reintentar: jest.Mock };
  contadores?: Record<string, number>;
} = {}) {
  const config = { tareasActivas: jest.fn(async () => opciones.activas ?? true) };
  const emisionDirecta = { modo: jest.fn(async () => opciones.modo ?? ({ activo: true, ambiente: 'produccion' } as ModoEmision)) };
  const emision = opciones.emision ?? { reintentar: jest.fn(async (id: number) => ({ id_envio: id })) };
  const envios = {
    candidatosTarea: jest.fn(async () => [...(opciones.candidatos ?? [])]),
    contadores: jest.fn(async () => ({ pendientes: 2, inciertos: 1, vencen_hoy: 3, vencidos: 4, ...(opciones.contadores ?? {}) })),
  };
  const tarea = new EmisionFiscalTarea(
    config as unknown as FiscalConfigService,
    emisionDirecta as unknown as EmisionDirecta,
    emision as unknown as SunatEmisionService,
    envios as unknown as EnvioFiscalRepository,
    new RelojPrueba(),
  );
  return { tarea, config, emisionDirecta, emision, envios };
}

describe('EmisionFiscalTarea (D7)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('no corre con las tareas apagadas ni con la emisión inactiva (interruptor, BETA apagada…)', async () => {
    const apagada = crear({ activas: false, candidatos: [1] });
    expect(await apagada.tarea.ejecutar()).toBe(0);
    expect(apagada.envios.candidatosTarea).not.toHaveBeenCalled();

    const detenida = crear({
      modo: { activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_BLOQUEADA', motivo: 'Clave SOL rechazada.' },
      candidatos: [1],
    });
    expect(await detenida.tarea.ejecutar()).toBe(0);
    expect(detenida.envios.candidatosTarea).not.toHaveBeenCalled();
    expect(detenida.emision.reintentar).not.toHaveBeenCalled();
  });

  it('toma hasta 10 envíos del ambiente VIGENTE y los manda por el camino seguro del reintento', async () => {
    const { tarea, envios, emision } = crear({ modo: { activo: true, ambiente: 'beta' }, candidatos: [4, 9] });
    expect(await tarea.ejecutar()).toBe(2);
    expect(envios.candidatosTarea).toHaveBeenCalledWith('beta', 10);
    expect(emision.reintentar.mock.calls).toEqual([
      [4, 'tarea'],
      [9, 'tarea'],
    ]);
  });

  it('dos instancias a la vez: cada envío se procesa una sola vez (el reclamo por fila decide)', async () => {
    const cola = new ColaCompartida([1, 2, 3, 4]);
    const a = crear({ candidatos: cola.pendientes, emision: cola.emisionDe('A') });
    const b = crear({ candidatos: cola.pendientes, emision: cola.emisionDe('B') });

    const [procesadosA, procesadosB] = await Promise.all([a.tarea.ejecutar(), b.tarea.ejecutar()]);

    expect(procesadosA + procesadosB).toBe(4);
    expect(cola.procesadosPor.map((p) => p.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('una vuelta no se solapa con la anterior (enCurso)', async () => {
    let liberar: () => void = () => undefined;
    const lenta = { reintentar: jest.fn(() => new Promise((resolver) => (liberar = () => resolver({})))) };
    const { tarea } = crear({ candidatos: [1], emision: lenta });
    const primera = tarea.ejecutar();
    await new Promise((r) => setImmediate(r));
    expect(await tarea.ejecutar()).toBe(0);
    liberar();
    expect(await primera).toBe(1);
  });

  it('si SUNAT detiene la emisión a mitad de la vuelta no insiste con los demás; un error suelto no corta la vuelta', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const emision = {
      reintentar: jest
        .fn()
        .mockRejectedValueOnce(new Error('BD lenta'))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new FiscalConfigError('FISCAL_EMISION_BLOQUEADA', 'detenida'))
        .mockResolvedValue({}),
    };
    const { tarea } = crear({ candidatos: [1, 2, 3, 4, 5], emision });
    expect(await tarea.ejecutar()).toBe(1);
    expect(emision.reintentar).toHaveBeenCalledTimes(3);
  });

  it('aporta a /fiscal/estado la emisión, la cola {pendientes, inciertos} y los plazos {vencen_hoy, vencidos}', async () => {
    const { tarea, envios } = crear({ modo: { activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA', motivo: 'No activada.' } });
    expect(await tarea.estadoOperativo()).toEqual({
      emision: { activa: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA', motivo: 'No activada.' },
      cola: { pendientes: 2, inciertos: 1 },
      plazos: { vencen_hoy: 3, vencidos: 4 },
      tareas: { activas: true, ultima_ejecucion: null },
    });
    expect(envios.contadores).toHaveBeenCalledWith('produccion', '2026-10-21');
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
