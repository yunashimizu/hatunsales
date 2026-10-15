import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  EMISOR_PRUEBA_BETA,
  PROBADOR_ENVIO_CPE,
} from '../config/fiscal-tokens';
import { REGISTRO_SUNAT_CONFIG } from '../registro/config.registro';
import { REGISTRO_SUNAT_EMISION } from '../registro/emision.registro';
import { REGISTRO_SUNAT_NUCLEO } from '../registro/nucleo.registro';
import { EmisorBetaService } from './emisor-beta.service';
import { ProbadorEnvioCpeService } from './probador-envio-cpe.service';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';

describe('registro de emisión BETA', () => {
  it('conecta el probador del panel con el circuito y el emisor separado sin dependencias circulares', async () => {
    const modulo = await Test.createTestingModule({
      controllers: REGISTRO_SUNAT_EMISION.controladores,
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ...REGISTRO_SUNAT_NUCLEO.proveedores,
        ...REGISTRO_SUNAT_EMISION.proveedores,
        ConfiguracionRepository,
        {
          provide: getDataSourceToken('pgConnection'),
          useValue: { query: jest.fn(), transaction: jest.fn() },
        },
      ],
    }).compile();
    expect(modulo.get(PROBADOR_ENVIO_CPE)).toBe(
      modulo.get(ProbadorEnvioCpeService),
    );
    expect(modulo.get(EMISOR_PRUEBA_BETA)).toBe(modulo.get(EmisorBetaService));
    expect(modulo.get(SunatEmisionBetaService)).toBeInstanceOf(
      SunatEmisionBetaService,
    );
    await modulo.close();
  });

  it('el probador no emite ni consume correlativos si recibe ambiente producción', async () => {
    const emision = { emitir: jest.fn() };
    const config = { siguienteCorrelativoBeta: jest.fn() };
    const probador = new ProbadorEnvioCpeService(
      emision as any,
      config as any,
      {} as any,
      {} as any,
    );
    const resultado = await probador.probar({ ambiente: 'produccion' } as any);
    expect(resultado).toEqual([
      {
        paso: 'envio',
        ok: null,
        detalle: expect.stringContaining('exclusivamente en SUNAT BETA'),
      },
    ]);
    expect(emision.emitir).not.toHaveBeenCalled();
    expect(config.siguienteCorrelativoBeta).not.toHaveBeenCalled();
  });
});
