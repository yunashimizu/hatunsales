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
