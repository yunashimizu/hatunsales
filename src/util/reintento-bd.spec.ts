import { Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { reintentarSiHuboConflicto } from './reintento-bd';

/** Error como lo entrega TypeORM: QueryFailedError con el error del driver dentro. */
function errorPg(code: string, mensaje = 'error de prueba'): QueryFailedError {
  const driver = Object.assign(new Error(mensaje), { code, severity: 'ERROR', routine: 'prueba' });
  return new QueryFailedError('UPDATE inventario SET stock = 1', [], driver);
}

describe('reintentarSiHuboConflicto', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('repite la transacción tras un interbloqueo (40P01) y devuelve lo que dio la segunda vuelta', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(errorPg('40P01', 'deadlock detected'))
      .mockResolvedValueOnce('ok');

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
  });

  it('también repite con el error crudo del driver y con 40001 (serialización)', async () => {
    const crudo = Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' });
    const fn = jest.fn().mockRejectedValueOnce(crudo).mockResolvedValueOnce(7);

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 0 })).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('no repite una violación de único (23505): la relanza tal cual al primer intento', async () => {
    const unico = errorPg('23505', 'duplicate key value');
    const fn = jest.fn().mockRejectedValue(unico);

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 0 })).rejects.toBe(unico);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('no repite errores que no son de la base', async () => {
    const propio = new Error('STOCK_INSUFICIENTE:3:1');
    const fn = jest.fn().mockRejectedValue(propio);

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 0 })).rejects.toBe(propio);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('se rinde al tercer intento y relanza el error original del último', async () => {
    const errores = [errorPg('40P01'), errorPg('40P01'), errorPg('40P01')];
    const fn = jest.fn()
      .mockRejectedValueOnce(errores[0])
      .mockRejectedValueOnce(errores[1])
      .mockRejectedValueOnce(errores[2]);

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 0 })).rejects.toBe(errores[2]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('espera esperaBaseMs × intento más un azar menor que esperaBaseMs', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const tiempos: number[] = [];
    const original = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      tiempos.push(Number(ms));
      return original(cb, 0);
    }) as typeof setTimeout);
    const fn = jest.fn()
      .mockRejectedValueOnce(errorPg('40P01'))
      .mockRejectedValueOnce(errorPg('40P01'))
      .mockResolvedValueOnce('ok');

    await expect(reintentarSiHuboConflicto(fn, { esperaBaseMs: 40 })).resolves.toBe('ok');
    expect(tiempos).toEqual([40 + 20, 80 + 20]);
  });
});
