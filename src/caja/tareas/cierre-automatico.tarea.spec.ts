import { Logger } from '@nestjs/common';
import { CierreAutomaticoTarea, intervaloCierreAutomaticoMs } from './cierre-automatico.tarea';

describe('CierreAutomaticoTarea (Fase 7.4)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  function armar(horas: number, ids: number[] = [55, 56]) {
    const repo = { turnosOlvidados: jest.fn(async () => ids) };
    const sesiones = { cerrarAutomatico: jest.fn(async (id: number) => id !== 56) };
    const control = { horasCierreAutomatico: jest.fn(async () => horas) };
    return { tarea: new CierreAutomaticoTarea(repo as never, sesiones as never, control as never), repo, sesiones };
  }

  it('apagada por defecto (0 h): no busca turnos ni cierra nada', async () => {
    const { tarea, repo, sesiones } = armar(0);
    expect(await tarea.ejecutar()).toBe(0);
    expect(repo.turnosOlvidados).not.toHaveBeenCalled();
    expect(sesiones.cerrarAutomatico).not.toHaveBeenCalled();
  });

  it('encendida: cierra los turnos más viejos que las horas configuradas; uno ya cerrado no cuenta', async () => {
    const { tarea, repo, sesiones } = armar(16);
    expect(await tarea.ejecutar()).toBe(1);
    expect(repo.turnosOlvidados).toHaveBeenCalledWith(16, 20);
    expect(sesiones.cerrarAutomatico).toHaveBeenCalledWith(55, 16);
    expect(sesiones.cerrarAutomatico).toHaveBeenCalledWith(56, 16);
  });

  it('un turno que falla no frena a los demás; un fallo general no lanza', async () => {
    const { tarea, sesiones, repo } = armar(16, [1, 2]);
    sesiones.cerrarAutomatico.mockRejectedValueOnce(new Error('candado'));
    expect(await tarea.ejecutar()).toBe(1);
    repo.turnosOlvidados.mockRejectedValueOnce(new Error('sin base'));
    expect(await tarea.ejecutar()).toBe(0);
  });

  it('intervalo: 15 min por defecto, 0 apaga el temporizador, mínimo 5', () => {
    expect(intervaloCierreAutomaticoMs(undefined)).toBe(15 * 60_000);
    expect(intervaloCierreAutomaticoMs('0')).toBe(0);
    expect(intervaloCierreAutomaticoMs('1')).toBe(5 * 60_000);
  });
});
