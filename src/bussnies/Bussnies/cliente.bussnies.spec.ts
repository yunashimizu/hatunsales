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
