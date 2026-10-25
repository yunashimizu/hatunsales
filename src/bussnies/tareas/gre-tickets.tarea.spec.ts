import { GreTicketsTarea } from './gre-tickets.tarea';

function montar() {
  const config = { tareasActivas: jest.fn(async () => true), greActiva: jest.fn(async () => true) };
  const emisionGre = { modo: jest.fn(async () => ({ activo: true })) };
  const guias = {
    candidatosConsulta: jest.fn(async () => [11, 12, 13]),
    consultarEnvio: jest.fn(async () => ({ guia: {}, resultado: {} })),
  };
  const tarea = new GreTicketsTarea(config as any, emisionGre as any, guias as any);
  return { tarea, config, emisionGre, guias };
}

describe('GreTicketsTarea (consulta automática de tickets de la GRE)', () => {
  it('no corre sin tareas activas ni con la GRE apagada, y entonces no lee credenciales', async () => {
    const { tarea, config, emisionGre, guias } = montar();
    config.tareasActivas.mockResolvedValueOnce(false);
    expect(await tarea.ejecutar()).toBe(0);
    config.greActiva.mockResolvedValueOnce(false);
    expect(await tarea.ejecutar()).toBe(0);
    expect(guias.candidatosConsulta).not.toHaveBeenCalled();
    expect(emisionGre.modo).not.toHaveBeenCalled();
  });

  it('sin tickets pendientes no pregunta el modo; con el modo inactivo no consulta', async () => {
    const { tarea, emisionGre, guias } = montar();
    guias.candidatosConsulta.mockResolvedValueOnce([]);
    expect(await tarea.ejecutar()).toBe(0);
    expect(emisionGre.modo).not.toHaveBeenCalled();

    emisionGre.modo.mockResolvedValueOnce({ activo: false, codigo: 'GRE_DESACTIVADA', motivo: '…' } as any);
    expect(await tarea.ejecutar()).toBe(0);
    expect(guias.consultarEnvio).not.toHaveBeenCalled();
  });

  it('consulta hasta 10 por vuelta; uno tomado por otra réplica o que falla no detiene a los demás', async () => {
    const { tarea, guias } = montar();
    guias.consultarEnvio
      .mockResolvedValueOnce(null as any)
      .mockRejectedValueOnce(new Error('SUNAT no respondió'))
      .mockResolvedValueOnce({ guia: {}, resultado: {} });
    expect(await tarea.ejecutar()).toBe(1);
    expect(guias.candidatosConsulta).toHaveBeenCalledWith(GreTicketsTarea.GUIAS_POR_VUELTA);
    expect(guias.consultarEnvio.mock.calls.map((c: unknown[]) => c[0])).toEqual([11, 12, 13]);
  });

  it('no se superpone consigo misma y un error de la BD no la detiene', async () => {
    const { tarea, guias } = montar();
    let liberar: (valor: number[]) => void = () => undefined;
    guias.candidatosConsulta.mockReturnValueOnce(new Promise<number[]>((resolve) => (liberar = resolve)));
    const primera = tarea.ejecutar();
    expect(await tarea.ejecutar()).toBe(0);
    liberar([]);
    expect(await primera).toBe(0);

    guias.candidatosConsulta.mockRejectedValueOnce(new Error('conexión cerrada'));
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
