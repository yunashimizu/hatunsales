import { ConflictException } from '@nestjs/common';
import { AuthBussnies } from './auth.bussnies';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { HashUtil } from '../../util/jwt/hash.util';
import { googleAuthConfig } from '../../config/google-auth.config';

/**
 * Un correo = una cuenta, sin distinguir mayúsculas (como el login).
 *
 * La "BD" falsa compara el email igual que PostgreSQL: exacto en findOne({ email }) y sin
 * mayúsculas en LOWER(u.email) = :email. Las transacciones se ejecutan de a una, como el
 * candado consultivo por correo que toma el código real.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

function armar(iniciales: Array<{ id_usuario: number; email: string; rol?: string }> = []) {
  const usuarios: any[] = iniciales.map((u) => ({
    estado: true,
    password: 'hash-previo',
    nombre: 'Usuario ' + u.id_usuario,
    ...u,
    rol: { id_rol: u.rol === 'admin' ? 1 : 5, nombre: u.rol ?? 'cliente' },
  }));
  const clientes: any[] = [];
  const sentencias: Array<{ sql: string; params: any[] }> = [];
  let siguienteId = 100;

  const consulta = () => {
    const filtro: { email?: string; soloActivos?: boolean } = {};
    const qb: any = {
      leftJoinAndSelect: () => qb,
      where: (_condicion: string, params: any) => {
        filtro.email = params.email;
        return qb;
      },
      andWhere: (condicion: string) => {
        if (condicion.includes('estado')) filtro.soloActivos = true;
        return qb;
      },
      orderBy: () => qb,
      getOne: async () => {
        await tick();
        return (
          usuarios
            .filter((u) => String(u.email).toLowerCase() === filtro.email && (!filtro.soloActivos || u.estado))
            .sort((a, b) => a.id_usuario - b.id_usuario)[0] ?? null
        );
      },
    };
    return qb;
  };

  const repoUsuarios: any = {
    createQueryBuilder: consulta,
    findOne: async ({ where }: any) => {
      await tick();
      return (
        usuarios.find(
          (u) =>
            (where.email === undefined || u.email === where.email) &&
            (where.id_usuario === undefined || u.id_usuario === where.id_usuario),
        ) ?? null
      );
    },
    create: (datos: any) => ({ ...datos }),
    save: async (datos: any) => {
      await tick();
      const guardado = { ...datos, id_usuario: datos.id_usuario ?? siguienteId++ };
      usuarios.push(guardado);
      return guardado;
    },
  };
  const repoClientes: any = {
    create: (datos: any) => ({ ...datos }),
    save: async (datos: any) => {
      clientes.push(datos);
      return datos;
    },
    findOne: async () => null,
  };

  let cola: Promise<unknown> = Promise.resolve();
  const manager = {
    query: async (sql: string, params: any[] = []) => {
      sentencias.push({ sql, params });
      return [];
    },
    getRepository: (entidad: unknown) => (entidad === Usuarios ? repoUsuarios : repoClientes),
  };
  repoUsuarios.manager = {
    transaction: jest.fn((trabajo: (m: any) => Promise<any>) => {
      const resultado = cola.then(() => trabajo(manager));
      cola = resultado.catch(() => undefined);
      return resultado;
    }),
  };

  const vwRepo = { find: async () => [] };
  const jwt = { sign: () => 'token-de-prueba' };
  const roles = { asegurarRolCliente: async () => ({ id_rol: 5, nombre: 'cliente' }) };
  const servicio = new AuthBussnies(repoUsuarios, vwRepo as any, repoClientes, jwt as any, roles as any);
  return { servicio, usuarios, clientes, sentencias, repoUsuarios };
}

const registro = (email: string) => ({ email, password: '12345678', nombre: 'Juan Pérez' });

describe('AuthBussnies · un correo, una cuenta', () => {
  beforeEach(() => {
    jest.spyOn(HashUtil, 'hashPassword').mockResolvedValue('hash-nuevo');
  });
  afterEach(() => jest.restoreAllMocks());

  it('no deja registrar "juan@mail.com" si ya existe "Juan@Mail.com"', async () => {
    const { servicio, usuarios } = armar([{ id_usuario: 1, email: 'Juan@Mail.com' }]);

    await expect(servicio.register(registro('juan@mail.com') as any)).rejects.toBeInstanceOf(ConflictException);
    expect(usuarios).toHaveLength(1);
  });

  it('un doble clic en "Crear cuenta" crea un solo usuario y un solo cliente', async () => {
    const { servicio, usuarios, clientes } = armar();

    const resultados = await Promise.allSettled([
      servicio.register(registro('Ana@Mail.com') as any),
      servicio.register(registro('ana@mail.com') as any),
    ]);

    expect(usuarios).toHaveLength(1);
    expect(clientes).toHaveLength(1);
    expect(clientes[0].usuario).toEqual({ id_usuario: usuarios[0].id_usuario });
    const rechazo = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rechazo.reason).toBeInstanceOf(ConflictException);
    expect(rechazo.reason.message).toBe('El email ya está registrado');
  });

  it('usuario y cliente se crean en una transacción, tras el candado del correo', async () => {
    const { servicio, sentencias, repoUsuarios } = armar();

    await servicio.register(registro('Rosa@Mail.com') as any);

    expect(repoUsuarios.manager.transaction).toHaveBeenCalledTimes(1);
    expect(sentencias[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(sentencias[0].params).toEqual(['auth:email:rosa@mail.com']);
  });

  it('si el índice único rechaza el correo (23505) responde 409 claro', async () => {
    const { servicio, usuarios, repoUsuarios } = armar();
    repoUsuarios.manager.transaction.mockImplementationOnce(async () => {
      usuarios.push({ id_usuario: 7, email: 'luis@mail.com', estado: true, rol: { id_rol: 5, nombre: 'cliente' } });
      throw Object.assign(new Error('duplicate key value violates unique constraint "uq_usuarios_email_lower"'), {
        code: '23505',
        constraint: 'uq_usuarios_email_lower',
      });
    });

    await expect(servicio.register(registro('luis@mail.com') as any)).rejects.toThrow('El email ya está registrado');
  });
});

describe('AuthBussnies · Google con correo guardado en mayúsculas', () => {
  const clienteIdOriginal = googleAuthConfig.clientId;
  beforeEach(() => {
    googleAuthConfig.clientId = 'cliente-google-de-prueba';
    jest.spyOn(HashUtil, 'hashPassword').mockResolvedValue('hash-nuevo');
  });
  afterEach(() => {
    googleAuthConfig.clientId = clienteIdOriginal;
    jest.restoreAllMocks();
  });

  it('entra a la cuenta existente en vez de crear otra separada', async () => {
    const { servicio, usuarios } = armar([{ id_usuario: 1, email: 'Juan@Mail.com', rol: 'admin' }]);
    (servicio as any).googleClient = {
      verifyIdToken: async () => ({ getPayload: () => ({ email: 'juan@mail.com', email_verified: true, name: 'Juan' }) }),
    };
    const res = { cookie: jest.fn() };

    const sesion = await servicio.loginConGoogle('credencial', res);

    expect(sesion.id_usuario).toBe(1);
    expect(sesion.mensaje).toBe('Inicio de sesión con Google');
    expect(usuarios).toHaveLength(1);
  });
});
