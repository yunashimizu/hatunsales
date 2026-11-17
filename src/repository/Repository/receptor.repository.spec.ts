import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { ReceptorRepository } from './receptor.repository';

/**
 * Fase A (A7): guardar por DNI o RUC toma un candado consultivo con esa clave ANTES de buscar,
 * dentro de la misma transacción, para que dos locales no creen dos fichas del mismo documento.
 */
function armar(existente: Record<string, unknown> | null) {
  const orden: string[] = [];
  const repoTx = {
    findOne: jest.fn(async () => {
      orden.push('buscar');
      return existente;
    }),
    update: jest.fn(async () => orden.push('actualizar')),
    create: jest.fn((data: unknown) => data),
    save: jest.fn(async (data: Record<string, unknown>) => {
      orden.push('insertar');
      return { ...data, id_cliente: 70, id_empresa: 80 };
    }),
  };
  const manager = {
    query: jest.fn(async () => orden.push('candado')),
    getRepository: jest.fn(() => repoTx),
  };
  const transaction = jest.fn(async (fn: (m: unknown) => unknown) => fn(manager));
  const repoRaiz = { manager: { transaction }, save: jest.fn(async (d: unknown) => d), create: jest.fn((d: unknown) => d) };
  const repo = new ReceptorRepository(repoRaiz as any, repoRaiz as any);
  return { repo, manager, repoTx, repoRaiz, transaction, orden };
}

describe('ReceptorRepository · sin fichas duplicadas por DNI o RUC', () => {
  it('cliente nuevo: candado cliente-dni:<dni> primero, luego busca e inserta, todo en una transacción', async () => {
    const { repo, manager, transaction, orden } = armar(null);

    await expect(repo.guardarCliente({ dni: 45678912, nombre: 'JUAN' })).resolves.toMatchObject({ id_cliente: 70 });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['cliente-dni:45678912']);
    expect(manager.getRepository).toHaveBeenCalledWith(Cliente);
    expect(orden).toEqual(['candado', 'buscar', 'insertar']);
  });

  it('cliente existente: actualiza solo los campos con valor y no inserta otro', async () => {
    const { repo, repoTx, orden } = armar({ id_cliente: 17, dni: 45678912, telefono: '999' });

    await repo.guardarCliente({ dni: 45678912, nombre: 'JUAN', telefono: '', direccion: undefined });

    expect(repoTx.update).toHaveBeenCalledWith(17, { dni: 45678912, nombre: 'JUAN' });
    expect(orden).toEqual(['candado', 'buscar', 'actualizar', 'buscar']);
  });

  it('empresa: candado empresa-ruc:<ruc> antes de buscar', async () => {
    const { repo, manager, orden } = armar(null);

    await repo.guardarEmpresa({ ruc: '20123456789', razon_social: 'FERRETERIA' });

    expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['empresa-ruc:20123456789']);
    expect(manager.getRepository).toHaveBeenCalledWith(Empresa);
    expect(orden).toEqual(['candado', 'buscar', 'insertar']);
  });

  it('sin documento no hay clave que bloquear: guarda como siempre, sin transacción', async () => {
    const { repo, transaction, repoRaiz } = armar(null);

    await repo.guardarCliente({ nombre: 'SIN DNI' });

    expect(transaction).not.toHaveBeenCalled();
    expect(repoRaiz.save).toHaveBeenCalledTimes(1);
  });
});

/** QueryBuilder falso que anota el WHERE y sus parámetros. */
function armarSugerencias() {
  const anotado: { where?: string; params?: Record<string, unknown> } = {};
  const qb: any = {
    where: jest.fn((sql: string, params: Record<string, unknown>) => {
      anotado.where = sql;
      anotado.params = params;
      return qb;
    }),
    orderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    getMany: jest.fn(async () => []),
  };
  const repoRaiz = { createQueryBuilder: jest.fn(() => qb) };
  const repo = new ReceptorRepository(repoRaiz as any, repoRaiz as any);
  return { repo, anotado };
}

describe('ReceptorRepository · sugerencias con comodines escritos por el usuario (B8)', () => {
  it('clientes: `%`, `_` y `\\` van escapados y cada LIKE lleva ESCAPE', async () => {
    const { repo, anotado } = armarSugerencias();

    await repo.sugerirClientes('Ana_50%\\', 10);

    expect(anotado.params).toEqual({ patron: '%ana\\_50\\%\\\\%' });
    expect(anotado.where!.match(/LIKE :patron ESCAPE '\\'/g)).toHaveLength(2);
  });

  it('empresas: `%`, `_` y `\\` van escapados y cada LIKE lleva ESCAPE', async () => {
    const { repo, anotado } = armarSugerencias();

    await repo.sugerirEmpresas('ACME_%', 10);

    expect(anotado.params).toEqual({ patron: '%acme\\_\\%%' });
    expect(anotado.where!.match(/LIKE :patron ESCAPE '\\'/g)).toHaveLength(3);
  });
});
