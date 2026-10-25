import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { RepositorioConfigFiscal } from './config-fiscal.repository';
import { snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
import type { FiscalConfigService } from './fiscal-config.service';
import { InterruptorEmisionFiscal } from './interruptor-emision.service';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { RelojFiscal } from './reloj-fiscal';
import type { TransaccionesFiscales } from './transacciones-fiscales';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-10-21T15:00:00.000Z');
  }
}

const ACTOR = { id_usuario: 7, nombre: 'Moisés', ip: '10.0.0.1' };

function crear(valores: Record<string, string> = {}, ambiente: 'beta' | 'produccion' = 'produccion') {
  const guardados: Record<string, string> = { ...valores };
  const repositorio = {
    leer: jest.fn(async (claves: readonly string[]) => Object.fromEntries(claves.map((c) => [c, guardados[c] || null]))),
    guardar: jest.fn(async (pares: Record<string, string>) => {
      Object.assign(guardados, pares);
    }),
  };
  const tx = { query: jest.fn() };
  const transacciones = { ejecutar: jest.fn(async (trabajo: (e: typeof tx) => Promise<unknown>) => trabajo(tx)) };
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const notificador = new NotificadorCambiosFiscales();
  const avisos: string[] = [];
  notificador.suscribir((tipo) => avisos.push(tipo));
  const config = { snapshotFresco: jest.fn(async () => snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_ambiente: ambiente })) };
  const interruptor = new InterruptorEmisionFiscal(
    repositorio as unknown as RepositorioConfigFiscal,
    transacciones as unknown as TransaccionesFiscales,
    auditoria as unknown as FiscalAuditoriaRepository,
    notificador,
    config as unknown as FiscalConfigService,
    new RelojPrueba(),
  );
  return { interruptor, guardados, repositorio, auditoria, tx, avisos };
}

describe('InterruptorEmisionFiscal (D5.4)', () => {
  it('abrir guarda {codigo, motivo, fecha} del ambiente, lo audita y avisa el cambio de configuración', async () => {
    const { interruptor, guardados, auditoria, tx, avisos } = crear();
    const bloqueo = await interruptor.abrir('produccion', { codigo: '0102', motivo: 'SUNAT rechazó la clave SOL.' }, { id_envio: 40 });

    expect(bloqueo).toEqual({ codigo: '0102', motivo: 'SUNAT rechazó la clave SOL.', fecha: '2026-10-21T15:00:00.000Z' });
    expect(JSON.parse(guardados.fiscal_emision_bloqueada_produccion)).toEqual(bloqueo);
    expect(guardados.fiscal_emision_bloqueada_beta).toBeUndefined();
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'EMISION_BLOQUEADA', id_entidad: 'fiscal_emision_bloqueada_produccion', detalle: expect.objectContaining({ ambiente: 'produccion', id_envio: 40 }) }),
      tx,
    );
    expect(avisos).toEqual(['config']);
    expect(await interruptor.leer('produccion')).toEqual(bloqueo);
    expect(await interruptor.leer('beta')).toBeNull();
  });

  it('reanudar limpia el interruptor del ambiente VIGENTE y lo audita con el usuario', async () => {
    const bloqueo = { codigo: '2325', motivo: 'Certificado no registrado.', fecha: '2026-10-20T10:00:00.000Z' };
    const { interruptor, guardados, auditoria, avisos } = crear({
      fiscal_emision_bloqueada_produccion: JSON.stringify(bloqueo),
      fiscal_emision_bloqueada_beta: JSON.stringify(bloqueo),
    });

    expect(await interruptor.reanudar(ACTOR)).toEqual({ ambiente: 'produccion', reanudada: true, bloqueo_anterior: bloqueo });
    expect(guardados.fiscal_emision_bloqueada_produccion).toBe('');
    expect(guardados.fiscal_emision_bloqueada_beta).toBe(JSON.stringify(bloqueo));
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'EMISION_REANUDADA', id_usuario: 7, ip: '10.0.0.1', detalle: expect.objectContaining({ bloqueo, motivo: 'reanudada desde el panel' }) }),
      expect.anything(),
    );
    expect(avisos).toEqual(['config']);
  });

  it('reanudar sin interruptor abierto no escribe ni audita', async () => {
    const { interruptor, repositorio, auditoria, avisos } = crear({}, 'beta');
    expect(await interruptor.reanudar(ACTOR)).toEqual({ ambiente: 'beta', reanudada: false, bloqueo_anterior: null });
    expect(repositorio.guardar).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
    expect(avisos).toEqual([]);
  });

  it('limpiar dentro de la transacción de quien corrigió la causa (lee y escribe con el mismo ejecutor)', async () => {
    const { interruptor, repositorio, guardados } = crear({ fiscal_emision_bloqueada_beta: '{"codigo":"0102","motivo":"x","fecha":"f"}' });
    const ejecutor = { query: jest.fn() };
    expect(await interruptor.limpiar('beta', 'certificado digital actualizado', ACTOR, ejecutor)).toMatchObject({ codigo: '0102' });
    expect(repositorio.leer).toHaveBeenCalledWith(['fiscal_emision_bloqueada_beta'], ejecutor);
    expect(repositorio.guardar).toHaveBeenCalledWith({ fiscal_emision_bloqueada_beta: '' }, ejecutor);
    expect(guardados.fiscal_emision_bloqueada_beta).toBe('');
    expect(await interruptor.limpiar('beta', 'otra vez', ACTOR, ejecutor)).toBeNull();
  });
});
