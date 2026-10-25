import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { SaludFiscalService } from '../config/salud-fiscal.service';
import {
  EMISOR_PRUEBA_BETA,
  FUENTE_ESTADO_OPERATIVO_FISCAL,
  PROBADOR_ENVIO_CPE,
} from '../config/fiscal-tokens';
import { REGISTRO_SUNAT_CONFIG } from '../registro/config.registro';
import { REGISTRO_SUNAT_EMISION } from '../registro/emision.registro';
import { REGISTRO_SUNAT_NUCLEO } from '../registro/nucleo.registro';
import { EmisionFiscalTarea } from '../tareas/emision-fiscal.tarea';
import { BetaAdminController } from './beta-admin.controller';
import { EmisionDirectaService } from './emision-directa.service';
import { EmisionDirecta, OyenteEnvioFiscal, OyentesEnvioFiscal } from './emision.contrato';
import { EmisorBetaService } from './emisor-beta.service';
import { EnviosAdminController } from './envios-admin.controller';
import { ProbadorEnvioCpeService } from './probador-envio-cpe.service';
import { SunatEmisionService } from './sunat-emision.service';

describe('registro de la emisión directa (DI)', () => {
  /** BD vacía: cada consulta devuelve cero filas (BETA, emisión de prueba apagada). */
  async function compilar() {
    return Test.createTestingModule({
      controllers: [...REGISTRO_SUNAT_CONFIG.controladores, ...REGISTRO_SUNAT_EMISION.controladores],
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ...REGISTRO_SUNAT_NUCLEO.proveedores,
        ...REGISTRO_SUNAT_EMISION.proveedores,
        ConfiguracionRepository,
        {
          provide: getDataSourceToken('pgConnection'),
          useValue: { query: jest.fn(async () => []), transaction: jest.fn() },
        },
      ],
    }).compile();
  }

  it('expone el contrato EmisionDirecta, los oyentes (singleton), la tarea y los controladores sin ciclos', async () => {
    const modulo = await compilar();
    expect(modulo.get(EmisionDirecta)).toBe(modulo.get(EmisionDirectaService));
    expect(modulo.get(SunatEmisionService)).toBeInstanceOf(SunatEmisionService);
    expect(modulo.get(PROBADOR_ENVIO_CPE)).toBe(modulo.get(ProbadorEnvioCpeService));
    expect(modulo.get(EMISOR_PRUEBA_BETA)).toBe(modulo.get(EmisorBetaService));
    expect(modulo.get(FUENTE_ESTADO_OPERATIVO_FISCAL)).toBe(modulo.get(EmisionFiscalTarea));
    expect(modulo.get(BetaAdminController)).toBeInstanceOf(BetaAdminController);
    expect(modulo.get(EnviosAdminController)).toBeInstanceOf(EnviosAdminController);

    const oyentes = modulo.get(OyentesEnvioFiscal);
    expect(oyentes).toBeInstanceOf(OyentesEnvioFiscal);
    expect(modulo.get(OyentesEnvioFiscal)).toBe(oyentes);
    // Un oyente registrado por el negocio recibe los eventos de este mismo singleton.
    const recibidos: string[] = [];
    class OyentePrueba extends OyenteEnvioFiscal {
      async alCompletarEnvio(evento: { origen: string }) {
        recibidos.push(evento.origen);
      }
    }
    oyentes.registrar(new OyentePrueba());
    await oyentes.notificar({ id_envio: 1, id_comprobante: 2, ambiente: 'beta', tipo_documento: '01', estado: 'ACEPTADO', aceptado: true, origen: 'envio' });
    expect(recibidos).toEqual(['envio']);
    await modulo.close();
  });

  it('con la BD vacía la emisión queda inactiva (BETA apagada) y /fiscal/estado trae emisión, cola y plazos', async () => {
    const modulo = await compilar();
    expect(await modulo.get(EmisionDirecta).modo()).toMatchObject({
      activo: false,
      ambiente: 'beta',
      codigo: 'FISCAL_BETA_POS_APAGADO',
    });
    const estado = await modulo.get(SaludFiscalService).estado();
    expect(estado.emision).toMatchObject({ activa: false, ambiente: 'beta', codigo: 'FISCAL_BETA_POS_APAGADO' });
    expect(estado.cola).toEqual({ pendientes: 0, inciertos: 0 });
    expect(estado.plazos).toEqual({ vencen_hoy: 0, vencidos: 0 });
    expect(estado.bloqueo).toBeNull();
    await modulo.close();
  });

  it('el probador del panel no emite ni numera nada si recibe el ambiente de producción', async () => {
    const emision = { emitirPrueba: jest.fn() };
    const envios = { siguienteNumeroPruebaBeta: jest.fn() };
    const probador = new ProbadorEnvioCpeService(emision as any, envios as any, {} as any, {} as any);
    const resultado = await probador.probar({ ambiente: 'produccion' } as any);
    expect(resultado).toEqual([{ paso: 'envio', ok: null, detalle: expect.stringContaining('exclusivamente en SUNAT BETA') }]);
    expect(emision.emitirPrueba).not.toHaveBeenCalled();
    expect(envios.siguienteNumeroPruebaBeta).not.toHaveBeenCalled();
  });

  it('en BETA el probador numera después de lo ya enviado en la serie y no crea comprobantes', async () => {
    const emision = {
      emitirPrueba: jest.fn(async () => ({
        nombre_base: '20614736420-03-BB01-00000005',
        aceptado: true,
        codigo: '0',
        mensaje: 'Aceptada',
        observaciones: [],
        id_envio: 9,
        archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
      })),
    };
    const envios = { siguienteNumeroPruebaBeta: jest.fn(async () => 5) };
    const probador = new ProbadorEnvioCpeService(
      emision as any,
      envios as any,
      { exigir: jest.fn(async () => undefined) } as any,
      { ahora: () => new Date('2026-10-21T15:00:00Z') } as any,
    );
    const emisor = {
      ruc: '20614736420',
      razonSocial: 'EMISOR DE PRUEBAS',
      direccion: 'DOMICILIO DE PRUEBA',
      ubigeo: '150101',
      distrito: 'LIMA',
      provincia: 'LIMA',
      departamento: 'LIMA',
      codigoEstablecimiento: '0000',
    };
    const pasos = await probador.probar({ ambiente: 'beta', documento: 'cpe', tipoCpe: '03', emisor, material: {} as any, idUsuario: 4 });
    expect(envios.siguienteNumeroPruebaBeta).toHaveBeenCalledWith('BB01');
    const [documento, , idUsuario] = emision.emitirPrueba.mock.calls[0] as unknown as [{ serie: string; numero: number }, unknown, number];
    expect(documento).toMatchObject({ serie: 'BB01', numero: 5 });
    expect(idUsuario).toBe(4);
    expect(pasos.at(-1)).toMatchObject({ paso: 'respuesta_sunat', ok: true, envio_id: 9 });
  });
});
