import { Cliente } from '../../models/DBModel/cliente.entity';
import { Documento } from '../../models/DBModel/documento.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { SunatRepository } from './sunat.repository';

/**
 * Fase A (A7): quien llama busca el documento, consulta SUNAT y recién guarda. El guardado toma
 * el mismo candado que ReceptorRepository y vuelve a buscar: si otro local ya lo guardó, lo devuelve.
 */
function armar(existente: Record<string, unknown> | null) {
  const orden: string[] = [];
  const repos = new Map<unknown, any>();
  const repoDe = (entidad: unknown) => {
    if (!repos.has(entidad)) {
      repos.set(entidad, {
        findOne: jest.fn(async () => {
          orden.push('buscar');
          return existente;
        }),
        create: jest.fn((data: unknown) => data),
        save: jest.fn(async (data: Record<string, unknown>) => {
          orden.push(`insertar ${(entidad as { name: string }).name}`);
          return { ...data, id: 1 };
        }),
      });
    }
    return repos.get(entidad);
  };
  const manager = { query: jest.fn(async () => orden.push('candado')), getRepository: jest.fn(repoDe) };
  const raiz = { manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) } };
  const repo = new SunatRepository(raiz as any, {} as any, raiz as any, {} as any);
  return { repo, manager, orden, repoDe };
}

const DNI = { nombre: 'JUAN', apellido_paterno: 'PEREZ', apellido_materno: 'RUIZ', dni: 45678912 };

describe('SunatRepository · sin fichas duplicadas', () => {
  it('cliente nuevo: candado cliente-dni:<dni>, búsqueda, documento y cliente en la misma transacción', async () => {
    const { repo, manager, orden } = armar(null);

    await repo.guardarCliente(DNI);

    expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['cliente-dni:45678912']);
    expect(orden).toEqual(['candado', 'buscar', `insertar ${Documento.name}`, `insertar ${Cliente.name}`]);
  });

  it('si otro local lo guardó mientras se consultaba SUNAT, devuelve esa ficha y no crea nada', async () => {
    const ya = { id_cliente: 17, dni: 45678912 };
    const { repo, orden } = armar(ya);

    await expect(repo.guardarCliente(DNI)).resolves.toBe(ya);
    expect(orden).toEqual(['candado', 'buscar']);
  });

  it('empresa: candado empresa-ruc:<ruc>; si ya existe la devuelve', async () => {
    const nueva = armar(null);
    await nueva.repo.guardarEmpresa({ ruc: '20123456789', razon_social: 'FERRETERIA' });
    expect(nueva.manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['empresa-ruc:20123456789']);
    expect(nueva.orden).toEqual(['candado', 'buscar', `insertar ${Empresa.name}`]);

    const ya = { id_empresa: 31, ruc: '20123456789' };
    const repetida = armar(ya);
    await expect(repetida.repo.guardarEmpresa({ ruc: '20123456789' })).resolves.toBe(ya);
    expect(repetida.orden).toEqual(['candado', 'buscar']);
  });
});
