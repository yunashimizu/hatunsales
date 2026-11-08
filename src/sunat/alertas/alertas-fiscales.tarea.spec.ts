import { Logger } from '@nestjs/common';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { AlertasFiscalesService } from './alertas-fiscales.service';
import { AlertasFiscalesTarea } from './alertas-fiscales.tarea';

class RelojPrueba extends RelojFiscal {
  momento: Date;
  constructor(iso: string) {
    super();
    this.momento = new Date(`${iso}-05:00`); // Lima es UTC−5 todo el año
  }
  ahora(): Date {
    return this.momento;
  }
}

function crear(opciones: { activas?: boolean; hora?: string; falla?: boolean } = {}) {
  const config = { tareasActivas: jest.fn(async () => opciones.activas ?? true) };
  const alertas = {
    enviarDelDia: jest.fn(async () => {
      if (opciones.falla) throw new Error('correo caído');
      return { detectadas: [], enviadas: [], repetidas: [], destinatario: null };
    }),
  };
  const reloj = new RelojPrueba(`2026-11-09T${opciones.hora ?? '08:05'}:00`);
  const tarea = new AlertasFiscalesTarea(config as unknown as FiscalConfigService, alertas as unknown as AlertasFiscalesService, reloj);
  return { tarea, config, alertas, reloj };
}

describe('AlertasFiscalesTarea (aviso diario por correo, 08:00 Lima)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('antes de las 08:00 de Lima no revisa nada', async () => {
    const { tarea, alertas } = crear({ hora: '07:59' });
    await expect(tarea.ejecutar()).resolves.toBe(false);
    expect(alertas.enviarDelDia).not.toHaveBeenCalled();
  });

  it('desde las 08:00 revisa y envía una vez; las vueltas siguientes del mismo día no repiten', async () => {
    const { tarea, alertas } = crear({ hora: '08:00' });
    await expect(tarea.ejecutar()).resolves.toBe(true);
    await expect(tarea.ejecutar()).resolves.toBe(false);
    await expect(tarea.ejecutar()).resolves.toBe(false);
    expect(alertas.enviarDelDia).toHaveBeenCalledTimes(1);
  });

  it('al día siguiente vuelve a revisar', async () => {
    const { tarea, alertas, reloj } = crear({ hora: '09:00' });
    await tarea.ejecutar();
    reloj.momento = new Date('2026-11-10T09:00:00-05:00');
    await expect(tarea.ejecutar()).resolves.toBe(true);
    expect(alertas.enviarDelDia).toHaveBeenCalledTimes(2);
  });

  it('sin fiscal_tareas_activas no hace nada', async () => {
    const { tarea, alertas } = crear({ activas: false });
    await expect(tarea.ejecutar()).resolves.toBe(false);
    expect(alertas.enviarDelDia).not.toHaveBeenCalled();
  });

  it('si el correo falla no da la revisión por hecha y reintenta en la vuelta siguiente', async () => {
    const { tarea, alertas } = crear({ falla: true });
    await expect(tarea.ejecutar()).resolves.toBe(false);
    await expect(tarea.ejecutar()).resolves.toBe(false);
    expect(alertas.enviarDelDia).toHaveBeenCalledTimes(2);
  });

  it('no corre dos veces a la vez', async () => {
    const { tarea, alertas } = crear();
    let liberar!: () => void;
    alertas.enviarDelDia.mockImplementationOnce(() => new Promise((r) => { liberar = () => r({ detectadas: [], enviadas: [], repetidas: [], destinatario: null }); }));
    const primera = tarea.ejecutar();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(tarea.ejecutar()).resolves.toBe(false);
    liberar();
    await expect(primera).resolves.toBe(true);
    expect(alertas.enviarDelDia).toHaveBeenCalledTimes(1);
  });
});
