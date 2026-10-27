import { CorreoComprobantesTarea } from './correo-comprobantes.tarea';

function montar() {
  const config = { tareasActivas: jest.fn(async () => true) };
  const repo = {
    omitirRechazados: jest.fn(async () => 0),
    sembrar: jest.fn(async () => 0),
    candidatos: jest.fn(async () => [11, 12, 13]),
  };
  const correo = {
    tablaDisponible: jest.fn(async () => true),
    activo: jest.fn(async () => true),
    procesar: jest.fn(async () => 'ENVIADO'),
  };
  const tarea = new CorreoComprobantesTarea(config as any, repo as any, correo as any);
  return { tarea, config, repo, correo };
}

describe('CorreoComprobantesTarea (envío automático de correos de comprobantes)', () => {
  it('no corre sin tareas activas, sin tabla ni con el interruptor apagado, y entonces no toca la cola', async () => {
    const { tarea, config, repo, correo } = montar();
    config.tareasActivas.mockResolvedValueOnce(false);
    expect(await tarea.ejecutar()).toBe(0);
    correo.tablaDisponible.mockResolvedValueOnce(false);
    expect(await tarea.ejecutar()).toBe(0);
    correo.activo.mockResolvedValueOnce(false);
    expect(await tarea.ejecutar()).toBe(0);
    expect(repo.omitirRechazados).not.toHaveBeenCalled();
    expect(repo.sembrar).not.toHaveBeenCalled();
    expect(correo.procesar).not.toHaveBeenCalled();
  });

  it('omite rechazados, siembra y procesa hasta 10 por vuelta, en ese orden', async () => {
    const { tarea, repo, correo } = montar();
    expect(await tarea.ejecutar()).toBe(3);
    expect(repo.omitirRechazados.mock.invocationCallOrder[0]).toBeLessThan(repo.sembrar.mock.invocationCallOrder[0]);
    expect(repo.sembrar.mock.invocationCallOrder[0]).toBeLessThan(repo.candidatos.mock.invocationCallOrder[0]);
    expect(repo.sembrar).toHaveBeenCalledWith(CorreoComprobantesTarea.SEMBRADOS_POR_VUELTA);
    expect(repo.candidatos).toHaveBeenCalledWith(CorreoComprobantesTarea.CORREOS_POR_VUELTA);
    expect(correo.procesar.mock.calls.map((c: unknown[]) => c[0])).toEqual([11, 12, 13]);
  });

  it('un correo tomado por otra réplica (null) o que falla no detiene a los demás ni se cuenta', async () => {
    const { tarea, correo } = montar();
    correo.procesar
      .mockResolvedValueOnce(null as any)
      .mockRejectedValueOnce(new Error('bd caída'))
      .mockResolvedValueOnce('ENVIADO');
    expect(await tarea.ejecutar()).toBe(1);
    expect(correo.procesar).toHaveBeenCalledTimes(3);
  });

  it('no se superpone consigo misma y un error de la BD no la detiene', async () => {
    const { tarea, repo } = montar();
    let liberar: (valor: number[]) => void = () => undefined;
    repo.candidatos.mockReturnValueOnce(new Promise<number[]>((resolve) => (liberar = resolve)));
    const primera = tarea.ejecutar();
    expect(await tarea.ejecutar()).toBe(0);
    liberar([]);
    expect(await primera).toBe(0);

    repo.sembrar.mockRejectedValueOnce(new Error('conexión cerrada'));
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
      jest.advanceTimersByTime(10 * 60_000);
      expect(config.tareasActivas).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
