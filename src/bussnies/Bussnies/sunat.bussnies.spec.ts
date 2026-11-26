import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { SunatBussnies, validarDni, validarRuc } from './sunat.bussnies';

/** B7: el DNI y el RUC van dentro de la URL de ApiPeru: solo dígitos y el largo exacto. */
describe('SunatBussnies · DNI y RUC solo dígitos (B7)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('validarDni: exactamente 8 dígitos', () => {
    expect(() => validarDni('12345678')).not.toThrow();
    for (const malo of ['1234567', '123456789', '1234567a', '../12345', '1234?a=b', '12345 78', '', undefined, 12345678]) {
      expect(() => validarDni(malo)).toThrow(new BadRequestException('El DNI debe tener 8 dígitos'));
    }
  });

  it('validarRuc: exactamente 11 dígitos', () => {
    expect(() => validarRuc('20123456789')).not.toThrow();
    for (const malo of ['2012345678', '201234567890', '2012345678x', '../../12345', '20123#56789', '', null]) {
      expect(() => validarRuc(malo)).toThrow(new BadRequestException('El RUC debe tener 11 dígitos'));
    }
  });

  it('con un número inválido no consulta la base ni arma la URL', async () => {
    const repo = { buscarClientePorDni: jest.fn(), buscarEmpresaPorRuc: jest.fn() };
    const get = jest.spyOn(axios, 'get');
    const servicio = new SunatBussnies(repo as never);

    await expect(servicio.consultarDni('../admin')).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.consultarRuc('2012345678#')).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.guardarClienteDni({ dni: '1234567?' } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.guardarEmpresaRuc({ ruc: '20123/56789' } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.buscarClientePorDni).not.toHaveBeenCalled();
    expect(repo.buscarEmpresaPorRuc).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * RUC con dígito verificador (módulo 11): se exige DESPUÉS de buscar en la base local y
 * ANTES de llamar a ApiPeru. Un RUC mal digitado no gasta cuota; uno ya guardado se devuelve.
 */
describe('SunatBussnies · RUC con dígito verificador', () => {
  const RUC_BUENO = '20131312955';
  const RUC_MALO = '20131312954'; // mismo número con el dígito final cambiado

  afterEach(() => jest.restoreAllMocks());

  function armar(enBase: any = null) {
    const repo = {
      buscarEmpresaPorRuc: jest.fn().mockResolvedValue(enBase),
      buscarProveedorPorRuc: jest.fn().mockResolvedValue(enBase),
      guardarEmpresa: jest.fn(),
      guardarProveedor: jest.fn(),
    };
    const get = jest.spyOn(axios, 'get');
    return { servicio: new SunatBussnies(repo as never), repo, get };
  }

  it('consultarRuc: dígito malo y no guardado → «RUC no válido», sin llamar a ApiPeru', async () => {
    const { servicio, repo, get } = armar();

    await expect(servicio.consultarRuc(RUC_MALO)).rejects.toThrow(new BadRequestException('RUC no válido'));
    expect(repo.buscarEmpresaPorRuc).toHaveBeenCalledWith(RUC_MALO); // primero se miró la base local
    expect(get).not.toHaveBeenCalled();
  });

  it('guardarEmpresaRuc y guardarProveedorRuc: dígito malo → «RUC no válido», sin llamar ni guardar', async () => {
    const { servicio, repo, get } = armar();

    await expect(servicio.guardarEmpresaRuc({ ruc: RUC_MALO } as never)).rejects.toThrow(new BadRequestException('RUC no válido'));
    await expect(servicio.guardarProveedorRuc({ ruc: RUC_MALO } as never)).rejects.toThrow(new BadRequestException('RUC no válido'));
    expect(get).not.toHaveBeenCalled();
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
    expect(repo.guardarProveedor).not.toHaveBeenCalled();
  });

  it('un RUC ya guardado se sigue devolviendo aunque su dígito esté mal', async () => {
    const guardada = { id_empresa: 7, ruc: RUC_MALO, razon_social: 'FERRETERIA ANTIGUA SAC' };
    const { servicio, get } = armar(guardada);

    const respuesta = await servicio.consultarRuc(RUC_MALO);

    expect(respuesta).toMatchObject({ success: true, id_empresa: 7, ruc: RUC_MALO, guardado: true });
    expect(get).not.toHaveBeenCalled();
  });

  it('el formato (11 dígitos) se sigue exigiendo primero: ni siquiera se mira la base', async () => {
    const { servicio, repo, get } = armar();

    await expect(servicio.consultarRuc('2013131295#')).rejects.toThrow(new BadRequestException('El RUC debe tener 11 dígitos'));
    expect(repo.buscarEmpresaPorRuc).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('un RUC válido y no guardado sí llega a ApiPeru', async () => {
    const { servicio, get } = armar();
    get.mockResolvedValue({ data: { ruc: RUC_BUENO, razonSocial: 'SUNAT', estado: 'ACTIVO', condicion: 'HABIDO' } });

    const respuesta = await servicio.consultarRuc(RUC_BUENO);

    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0][0])).toContain(`/${RUC_BUENO}?`);
    expect(respuesta).toMatchObject({ success: true, nombre: 'SUNAT', estado: 'ACTIVO', condicion: 'HABIDO', guardado: false });
  });
});
