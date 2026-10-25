import type { ModuleRef } from '@nestjs/core';
import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import type { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import type { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import type { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
import type { FiscalConfigService } from './fiscal-config.service';
import type { FiscalEsquemaService } from './fiscal-esquema.service';
import { PROBADOR_ENVIO_CPE } from './fiscal-tokens';
import { PruebaConexionFiscalService } from './prueba-conexion-fiscal.service';
import { RelojFiscal } from './reloj-fiscal';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date();
  }
}

const material = materialDePrueba(generarCertificadoPrueba());
const ACTOR = { id_usuario: 1, nombre: 'Admin', ip: null };

function crear() {
  const snapshot = snapshotPrueba(VALORES_COMPLETOS);
  const probador = { probar: jest.fn(async () => [{ paso: 'respuesta_sunat', ok: true, detalle: 'Aceptada' }]) };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === PROBADOR_ENVIO_CPE) return probador;
      throw new Error('no registrado');
    }),
  };
  const servicio = new PruebaConexionFiscalService(
    { snapshot: async () => snapshot, emisor: async () => ({ ...snapshot.emisor }) } as unknown as FiscalConfigService,
    { exigir: async () => undefined } as unknown as FiscalEsquemaService,
    { exigirDisponible: () => undefined } as unknown as CifradoFiscalService,
    { obtenerMaterialFirma: async () => ({ ...material }) } as unknown as CertificadoFiscalService,
    { obtener: async () => ({ usuario: '20610206337HATUN001', clave: 'secreta' }) } as unknown as CredencialesSolService,
    { obtener: jest.fn() } as unknown as CredencialesGreService,
    { registrar: jest.fn(async () => undefined) } as unknown as FiscalAuditoriaRepository,
    new RelojPrueba(),
    moduleRef as unknown as ModuleRef,
  );
  return { servicio, probador };
}

describe('Probar conexión: en producción nunca se envía un comprobante', () => {
  it('producción + factura/boleta: solo pasos locales y una indicación de la prueba de credenciales', async () => {
    const { servicio, probador } = crear();
    const resultado = await servicio.probar({ ambiente: 'produccion', documento: 'cpe', tipoCpe: '01' }, ACTOR);
    expect(probador.probar).not.toHaveBeenCalled();
    expect(resultado.pasos.map((p) => p.paso)).toEqual(['esquema', 'cifrado', 'certificado', 'firma', 'credenciales', 'envio']);
    expect(resultado.pasos.at(-1)).toMatchObject({ ok: null, detalle: expect.stringMatching(/Probar credenciales SOL de producción/) });
    expect(resultado.ok).toBe(true);
  });

  it('BETA: delega el envío de prueba en el probador del módulo de emisión', async () => {
    const { servicio, probador } = crear();
    const resultado = await servicio.probar({ ambiente: 'beta', documento: 'cpe', tipoCpe: '03' }, ACTOR);
    expect(probador.probar).toHaveBeenCalledWith(expect.objectContaining({ ambiente: 'beta', tipoCpe: '03' }));
    expect(resultado.pasos.at(-1)).toMatchObject({ paso: 'respuesta_sunat', ok: true });
  });
});
