import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import axios from 'axios';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { EmisionGre } from '../gre/gre.contrato';
import { GreEmisionService } from '../gre/gre-emision.service';
import { ClienteRestGre } from '../gre/gre-rest-client';
import { PreparadorGre } from '../gre/preparador-gre';
import { greVentaPublica } from '../gre/pruebas/documentos-gre-prueba-spec';
import { REGISTRO_SUNAT_CONFIG } from './config.registro';
import { REGISTRO_SUNAT_GRE } from './gre.registro';

/**
 * Integración de la inyección de dependencias del motor GRE (sin BD real ni red): todo se resuelve,
 * EmisionGre apunta al mismo GreEmisionService y, con la BD vacía, la GRE queda inactiva sin lanzar.
 */
describe('REGISTRO_SUNAT_GRE', () => {
  afterEach(() => jest.restoreAllMocks());

  async function compilar() {
    return Test.createTestingModule({
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ...REGISTRO_SUNAT_GRE.proveedores,
        ConfiguracionRepository,
        { provide: getDataSourceToken('pgConnection'), useValue: { query: jest.fn(() => Promise.resolve([])), transaction: jest.fn() } },
      ],
    }).compile();
  }

  it('EmisionGre es el mismo GreEmisionService y sus piezas se resuelven', async () => {
    const modulo = await compilar();
    expect(modulo.get(EmisionGre)).toBeInstanceOf(GreEmisionService);
    expect(modulo.get(EmisionGre)).toBe(modulo.get(GreEmisionService));
    expect(modulo.get(PreparadorGre)).toBeInstanceOf(PreparadorGre);
    expect(modulo.get(ClienteRestGre)).toBeInstanceOf(ClienteRestGre);
    await modulo.close();
  });

  it('con la BD vacía la GRE queda inactiva, valida sin enviar y no llama a la red', async () => {
    const red = jest.spyOn(axios, 'request');
    const modulo = await compilar();
    const emision = modulo.get(EmisionGre);

    const modo = await emision.modo();
    expect(modo.activo).toBe(false);
    expect(modo.activo === false && ['GRE_SIN_BETA', 'GRE_DESACTIVADA'].includes(modo.codigo)).toBe(true);

    expect(Array.isArray(emision.validar(greVentaPublica()).errores)).toBe(true);
    const envio = await emision.enviar({ nombreBase: '20610206337-09-T001-00000001' } as never);
    expect(envio.estado).toBe('ERROR_CONFIG');
    expect(red).not.toHaveBeenCalled();
    await modulo.close();
  });
});
