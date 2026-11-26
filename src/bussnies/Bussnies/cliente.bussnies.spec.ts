import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { ClienteBussnies } from './cliente.bussnies';

/**
 * Enlazar un cliente a una cuenta de la tienda solo ocurre al crear esa cuenta. El
 * id_usuario que llegue en el cuerpo de POST /cliente (o /cliente/registro) se ignora:
 * antes permitía colgar un segundo cliente de la cuenta de otra persona.
 */
function armar() {
  const repo = {
    buscarPorEmail: jest.fn().mockResolvedValue(null),
    buscarPorDni: jest.fn().mockResolvedValue(null),
    guardarConDocumento: jest.fn(async (datos: any) => ({ id_cliente: 31, ...datos })),
  };
  return { servicio: new ClienteBussnies(repo as any), repo };
}

describe('ClienteBussnies.create · no confía en id_usuario del cuerpo', () => {
  it('crea el cliente sin enlazarlo a la cuenta indicada', async () => {
    const { servicio, repo } = armar();

    const creado = await servicio.create({ nombre: 'Rosa', dni: 44556677, id_usuario: 1 } as any);

    const [datos] = repo.guardarConDocumento.mock.calls[0];
    expect(datos.usuario).toBeUndefined();
    expect(creado.tiene_cuenta).toBe(false);
    expect(creado.id_usuario).toBeUndefined();
  });
});

/**
 * Alta por RUC: la base local manda; si no está, se valida el dígito verificador y
 * recién entonces se sale a ApiPeru.
 */
describe('ClienteBussnies.crearDesdeSunatRuc · dígito verificador del RUC', () => {
  const RUC_BUENO = '20131312955';
  const RUC_MALO = '20131312954'; // mismo número con el dígito final cambiado

  afterEach(() => jest.restoreAllMocks());

  function armarEmpresa(enBase: any = null) {
    const repo = {
      buscarEmpresaPorRuc: jest.fn().mockResolvedValue(enBase),
      guardarEmpresa: jest.fn(async (datos: any) => ({ id_empresa: 3, ...datos })),
    };
    const get = jest.spyOn(axios, 'get');
    return { servicio: new ClienteBussnies(repo as any), repo, get };
  }

  it('RUC mal digitado y no guardado → «RUC no válido», sin llamar a ApiPeru ni guardar', async () => {
    const { servicio, repo, get } = armarEmpresa();

    await expect(servicio.create({ ruc_sunat: RUC_MALO } as any)).rejects.toThrow(new BadRequestException('RUC no válido'));
    expect(repo.buscarEmpresaPorRuc).toHaveBeenCalledWith(RUC_MALO); // primero se miró la base local
    expect(get).not.toHaveBeenCalled();
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
  });

  it('un RUC ya guardado se sigue devolviendo aunque su dígito esté mal', async () => {
    const guardada = { id_empresa: 8, ruc: RUC_MALO, razon_social: 'FERRETERIA ANTIGUA SAC' };
    const { servicio, get } = armarEmpresa(guardada);

    const respuesta = await servicio.crearDesdeSunatRuc(RUC_MALO);

    expect(respuesta.ruc).toBe(RUC_MALO);
    expect(get).not.toHaveBeenCalled();
  });

  it('un RUC válido y no guardado sí llega a ApiPeru y se registra', async () => {
    const { servicio, repo, get } = armarEmpresa();
    get.mockResolvedValue({ data: { razonSocial: 'SUNAT', estado: 'ACTIVO', condicion: 'HABIDO' } });

    await servicio.crearDesdeSunatRuc(RUC_BUENO);

    expect(get).toHaveBeenCalledTimes(1);
    expect(repo.guardarEmpresa).toHaveBeenCalledWith(expect.objectContaining({ ruc: RUC_BUENO, razon_social: 'SUNAT' }));
  });

  it('el alta manual por DNI no se ve afectada (no lleva RUC)', async () => {
    const repo = {
      buscarPorEmail: jest.fn().mockResolvedValue(null),
      buscarPorDni: jest.fn().mockResolvedValue(null),
      guardarConDocumento: jest.fn(async (datos: any) => ({ id_cliente: 40, ...datos })),
    };
    const servicio = new ClienteBussnies(repo as any);

    await servicio.create({ nombre: 'Rosa', dni: 44556677 } as any);

    expect(repo.guardarConDocumento).toHaveBeenCalledTimes(1);
  });
});
