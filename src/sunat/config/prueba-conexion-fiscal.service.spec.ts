import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
import { ProbarConexionDto } from './fiscal-config.dto';
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
  const probador = { probar: jest.fn(async (): Promise<Array<Record<string, unknown>>> => [{ paso: 'respuesta_sunat', ok: true, detalle: 'Aceptada' }]) };
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

describe('Probar conexión: «Los 4 documentos» (tipo_cpe todos)', () => {
  const enviado = (documento: string, ok: boolean | null, extra: Record<string, unknown> = {}) => ({
    paso: 'respuesta_sunat',
    ok,
    documento,
    detalle: `${documento}: ${ok ? 'Aceptada' : 'No'}`,
    ...extra,
  });

  it('el DTO admite 07, 08 y todos; rechaza otros valores', async () => {
    for (const tipo of ['01', '03', '07', '08', 'todos']) {
      expect(await validate(plainToInstance(ProbarConexionDto, { tipo_cpe: tipo }))).toHaveLength(0);
    }
    const errores = await validate(plainToInstance(ProbarConexionDto, { tipo_cpe: '09' }));
    expect(errores[0]?.constraints?.isIn).toContain('todos');
  });

  it('resume los cuatro documentos (tipo, ok, código, tiempo de SUNAT, envío) y ok solo si SUNAT aceptó los cuatro', async () => {
    const { servicio, probador } = crear();
    probador.probar.mockResolvedValueOnce([
      enviado('01', true, { codigo: '0', tiempo_ms: 2310, envio_id: 11 }),
      enviado('03', true, { codigo: '0', tiempo_ms: 900, envio_id: 12 }),
      enviado('07', true, { codigo: '0', tiempo_ms: 1200, envio_id: 13 }),
      enviado('08', true, { codigo: '0', tiempo_ms: 1500, envio_id: 14 }),
    ]);

    const resultado = await servicio.probar({ ambiente: 'beta', documento: 'cpe', tipoCpe: 'todos' }, ACTOR);

    expect(probador.probar).toHaveBeenCalledWith(expect.objectContaining({ tipoCpe: 'todos' }));
    expect(resultado.ok).toBe(true);
    expect(resultado.documentos).toEqual([
      { tipo: '01', ok: true, codigo: '0', tiempo_ms: 2310, envio_id: 11, detalle: '01: Aceptada' },
      { tipo: '03', ok: true, codigo: '0', tiempo_ms: 900, envio_id: 12, detalle: '03: Aceptada' },
      { tipo: '07', ok: true, codigo: '0', tiempo_ms: 1200, envio_id: 13, detalle: '07: Aceptada' },
      { tipo: '08', ok: true, codigo: '0', tiempo_ms: 1500, envio_id: 14, detalle: '08: Aceptada' },
    ]);
  });

  it('si la factura no fue aceptada las notas quedan «no intentadas» y el resultado no está bien', async () => {
    const { servicio, probador } = crear();
    probador.probar.mockResolvedValueOnce([
      enviado('01', false, { codigo: '2017' }),
      enviado('03', true, { codigo: '0' }),
      enviado('07', null),
      enviado('08', null),
    ]);

    const resultado = await servicio.probar({ ambiente: 'beta', documento: 'cpe', tipoCpe: 'todos' }, ACTOR);

    expect(resultado.ok).toBe(false);
    expect(resultado.documentos?.map((d) => [d.tipo, d.ok, d.tiempo_ms])).toEqual([
      ['01', false, null],
      ['03', true, null],
      ['07', null, null],
      ['08', null, null],
    ]);
  });

  it('una prueba de un solo documento sin pasos de envío marcados no trae documentos (respuesta de siempre)', async () => {
    const { servicio } = crear();
    const resultado = await servicio.probar({ ambiente: 'beta', documento: 'cpe', tipoCpe: '03' }, ACTOR);
    expect(resultado).not.toHaveProperty('documentos');
    expect(resultado.ok).toBe(true);
  });
});
