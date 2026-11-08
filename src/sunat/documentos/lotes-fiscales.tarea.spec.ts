import { Logger } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import { RelojFiscal } from '../config/reloj-fiscal';
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

class RelojPrueba extends RelojFiscal {
  /** 10:00 en Lima del 5/11/2026. */
  momento = new Date('2026-11-05T15:00:00Z');
  ahora(): Date {
    return this.momento;
  }
}

/** Lima es UTC−5 todo el año. */
const enLima = (iso: string) => new Date(`${iso}-05:00`);

function crear(opciones: {
  activas?: boolean;
  modo?: ModoEmision;
  candidatos?: number[];
  lotes?: { reintentar: jest.Mock; crearResumenAdicion?: jest.Mock };
  boletasModo?: 'individual' | 'resumen';
  resumenHora?: string;
  /** Fechas con boletas esperando resumen, por grupo del repositorio. */
  porResumir?: string[];
  atrasadas?: string[];
  ahora?: Date;
} = {}) {
  const snapshot = { boletasModo: opciones.boletasModo ?? 'individual', resumenHora: opciones.resumenHora ?? '23:30' };
  const config = { tareasActivas: jest.fn(async () => opciones.activas ?? true), snapshot: jest.fn(async () => snapshot) };
  const emisionDirecta = { modo: jest.fn(async () => opciones.modo ?? ({ activo: true, ambiente: 'produccion' } as ModoEmision)) };
  const lotes = {
    crearResumenAdicion: jest.fn(async (p: { fecha_emision: string }) => ({ id_envio: 1, fecha_emision: p.fecha_emision })),
    ...(opciones.lotes ?? { reintentar: jest.fn(async (id: number) => ({ id_envio: id })) }),
  };
  const repositorio = {
    candidatosTarea: jest.fn(async () => [...(opciones.candidatos ?? [])]),
    fechasConResumenPendiente: jest.fn(async (p: { grupo: string }) =>
      (p.grupo === 'por_resumir' ? opciones.porResumir ?? [] : opciones.atrasadas ?? []).map((fecha) => ({ fecha, cantidad: 2 })),
    ),
  };
  const reloj = new RelojPrueba();
  if (opciones.ahora) reloj.momento = opciones.ahora;
  const tarea = new LotesFiscalesTarea(
    config as unknown as FiscalConfigService,
    emisionDirecta as unknown as EmisionDirecta,
    lotes as unknown as LotesFiscalesService,
    repositorio as unknown as LoteFiscalRepository,
    reloj,
  );
  return { tarea, config, emisionDirecta, lotes, repositorio, reloj };
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

  describe('resúmenes diarios de adición (S2)', () => {
    const SISTEMA = { id_usuario: null, nombre: 'sistema', ip: null };

    it('modo resumen: las boletas de hoy esperan la hora configurada; las de días anteriores van en cuanto se puede', async () => {
      const antes = crear({ boletasModo: 'resumen', resumenHora: '23:30', porResumir: ['2026-11-04', '2026-11-05'], ahora: enLima('2026-11-05T23:29:00') });

      expect(await antes.tarea.ejecutar()).toBe(1);

      expect(antes.repositorio.fechasConResumenPendiente).toHaveBeenCalledWith({ ambiente: 'produccion', hoy: '2026-11-05', grupo: 'por_resumir', limite: 8 });
      expect(antes.lotes.crearResumenAdicion.mock.calls).toEqual([[{ fecha_emision: '2026-11-04', actor: SISTEMA, origen: 'tarea' }]]);

      // A las 23:30 ya toca el de hoy; sin repetir lo anterior porque el repositorio ya no lo devuelve.
      const despues = crear({ boletasModo: 'resumen', resumenHora: '23:30', porResumir: ['2026-11-05'], ahora: enLima('2026-11-05T23:30:00') });
      expect(await despues.tarea.ejecutar()).toBe(1);
      expect(despues.lotes.crearResumenAdicion).toHaveBeenCalledWith({ fecha_emision: '2026-11-05', actor: SISTEMA, origen: 'tarea' });
    });

    it('la hora es la configurada, no una fija: con 21:00 a las 21:00 ya crea el resumen de hoy', async () => {
      const antes = crear({ boletasModo: 'resumen', resumenHora: '21:00', porResumir: ['2026-11-05'], ahora: enLima('2026-11-05T20:59:59') });
      expect(await antes.tarea.ejecutar()).toBe(0);
      expect(antes.lotes.crearResumenAdicion).not.toHaveBeenCalled();
      const despues = crear({ boletasModo: 'resumen', resumenHora: '21:00', porResumir: ['2026-11-05'], ahora: enLima('2026-11-05T21:00:30') });
      expect(await despues.tarea.ejecutar()).toBe(1);
    });

    it('en modo individual las boletas que llevan más de 5 días sin aceptar entran solas a un resumen, una vez por fecha', async () => {
      const { tarea, repositorio, lotes } = crear({ boletasModo: 'individual', atrasadas: ['2026-10-30', '2026-10-31'], ahora: enLima('2026-11-05T09:00:00') });

      expect(await tarea.ejecutar()).toBe(2);

      expect(repositorio.fechasConResumenPendiente).toHaveBeenCalledWith({ ambiente: 'produccion', hoy: '2026-11-05', grupo: 'atrasadas', limite: 4 });
      expect(lotes.crearResumenAdicion.mock.calls.map(([p]) => [p.fecha_emision, p.origen])).toEqual([
        ['2026-10-30', 'tarea'],
        ['2026-10-31', 'tarea'],
      ]);
      // En modo individual lo POR_RESUMIR que haya quedado de antes no espera ninguna hora.
      const sobrantes = crear({ boletasModo: 'individual', porResumir: ['2026-11-05'], ahora: enLima('2026-11-05T09:00:00') });
      expect(await sobrantes.tarea.ejecutar()).toBe(1);
    });

    it('no duplica: sin fechas pendientes no crea nada, un resumen vacío (null) no cuenta y una vuelta crea como mucho 3', async () => {
      const vacia = crear({ boletasModo: 'resumen', ahora: enLima('2026-11-05T23:45:00') });
      expect(await vacia.tarea.ejecutar()).toBe(0);
      expect(vacia.lotes.crearResumenAdicion).not.toHaveBeenCalled();

      const nada = crear({ porResumir: ['2026-11-04'] });
      nada.lotes.crearResumenAdicion.mockResolvedValue(null);
      expect(await nada.tarea.ejecutar()).toBe(0);

      const muchas = crear({ porResumir: ['2026-11-01', '2026-11-02'], atrasadas: ['2026-10-30', '2026-10-31'] });
      expect(await muchas.tarea.ejecutar()).toBe(3);
      expect(muchas.lotes.crearResumenAdicion).toHaveBeenCalledTimes(3);
    });

    it('si la emisión se detiene deja de crear resúmenes; lo tomado por otro se salta; un error suelto no impide procesar los lotes pendientes', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const detenida = crear({ porResumir: ['2026-11-03', '2026-11-04'], candidatos: [7] });
      detenida.lotes.crearResumenAdicion.mockRejectedValue(new FiscalConfigError('FISCAL_EMISION_BLOQUEADA', 'detenida'));
      expect(await detenida.tarea.ejecutar()).toBe(1);
      expect(detenida.lotes.crearResumenAdicion).toHaveBeenCalledTimes(1);
      expect(detenida.lotes.reintentar).toHaveBeenCalledWith(7, 'tarea');

      const mezcla = crear({ porResumir: ['2026-11-02', '2026-11-03', '2026-11-04'], candidatos: [8] });
      mezcla.lotes.crearResumenAdicion
        .mockRejectedValueOnce(new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'otro proceso'))
        .mockRejectedValueOnce(new Error('BD lenta'))
        .mockResolvedValueOnce({ id_envio: 3 });
      expect(await mezcla.tarea.ejecutar()).toBe(2);

      const roto = crear({ candidatos: [9] });
      roto.repositorio.fechasConResumenPendiente.mockRejectedValue(new Error('conexión cerrada'));
      expect(await roto.tarea.ejecutar()).toBe(1);
    });
  });
});
