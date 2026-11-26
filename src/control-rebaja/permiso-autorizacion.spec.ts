import { createHmac } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../guards/jwt.strategy';
import { jwtConfig } from '../config/jwt.config';
import {
  claveDePermiso,
  crearDatosPermiso,
  firmarPermiso,
  huellaLineas,
  verificarPermiso,
  VIGENCIA_PERMISO_MS,
} from './permiso-autorizacion';

const AHORA = 1_764_000_000_000;
const CLAVE = claveDePermiso(jwtConfig.secret);
const LINEAS = [
  { id_producto: 7, cantidad: 2, precio_final: 7 },
  { id_producto: 9, cantidad: 1, precio_final: 25.5 },
];
const HUELLA = huellaLineas(LINEAS);
const VENDEDOR = 4;
const ADMIN = 1;

function permisoValido(parcial: { sol?: number; aut?: number; h?: string; ahora?: number } = {}) {
  const datos = crearDatosPermiso(parcial.sol ?? VENDEDOR, parcial.aut ?? ADMIN, parcial.h ?? HUELLA, parcial.ahora ?? AHORA);
  return { datos, permiso: firmarPermiso(datos, CLAVE) };
}

const esperado = (parcial: Partial<{ solicitante: number; huella: string; ahora: number }> = {}) => ({
  solicitante: VENDEDOR,
  huella: HUELLA,
  ahora: AHORA + 1_000,
  ...parcial,
});

/**
 * Pasa el texto por el mismo camino que una petición real: `passport-jwt` (extrae del encabezado
 * Authorization, verifica la firma con el secreto de JWT) y luego `JwtStrategy.validate`.
 */
function autenticar(token: string): Promise<'aceptado' | 'rechazado'> {
  const usuarioRepo = { findOne: jest.fn(async () => ({ id_usuario: ADMIN, nombre: 'Dueño', email: 'd@x.pe', estado: true, password: 'h', rol: { nombre: 'admin' } })) };
  const vwRepo = { find: jest.fn(async () => []) };
  const estrategia: any = new JwtStrategy(usuarioRepo as never, vwRepo as never);
  return new Promise((resolve) => {
    estrategia.success = () => resolve('aceptado');
    estrategia.fail = () => resolve('rechazado');
    estrategia.error = () => resolve('rechazado');
    estrategia.authenticate({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, {});
  });
}

describe('permiso de autorización (R5): NO sirve como sesión', () => {
  it('control: un JWT de sesión de verdad (sub + secreto de JWT) sí entra por JwtStrategy', async () => {
    const sesion = new JwtService({ secret: jwtConfig.secret }).sign({ sub: ADMIN, nombre: 'Dueño', email: 'd@x.pe', rol: 'admin', permisos: [] });
    await expect(autenticar(sesion)).resolves.toBe('aceptado');
  });

  it('(a) el permiso, tal cual, no pasa como sesión', async () => {
    const { permiso } = permisoValido({ sol: ADMIN, aut: ADMIN, ahora: Date.now() });
    await expect(autenticar(permiso)).resolves.toBe('rechazado');
  });

  it('(a) ni reempaquetado como JWT (cabecera HS256 + datos + su firma) ni re-firmado con la clave derivada', async () => {
    const { permiso } = permisoValido({ sol: ADMIN, aut: ADMIN, ahora: Date.now() });
    const [datos, firma] = permiso.split('.');
    const cabecera = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    await expect(autenticar(`${cabecera}.${datos}.${firma}`)).resolves.toBe('rechazado');
    // Firmado como JWT con la clave del permiso: tampoco (la clave no es el secreto de JWT).
    const firmaConClave = createHmac('sha256', CLAVE).update(`${cabecera}.${datos}`).digest('base64url');
    await expect(autenticar(`${cabecera}.${datos}.${firmaConClave}`)).resolves.toBe('rechazado');
  });

  it('(a) los datos del permiso no traen nada que JwtStrategy reconozca (sin sub ni exp)', async () => {
    const { datos } = permisoValido();
    expect(Object.keys(datos).sort()).toEqual(['aut', 'h', 'n', 'sol', 'v', 'vence']);
    const usuarioRepo = { findOne: jest.fn() };
    const estrategia = new JwtStrategy(usuarioRepo as never, { find: jest.fn() } as never);
    await expect(estrategia.validate(datos as never)).rejects.toThrow('Token inválido');
    expect(usuarioRepo.findOne).not.toHaveBeenCalled();
  });

  it('la clave del HMAC es derivada: distinta del secreto de JWT y de la de otro secreto', () => {
    expect(CLAVE.equals(Buffer.from(jwtConfig.secret))).toBe(false);
    expect(CLAVE).toHaveLength(32);
    expect(claveDePermiso('otro-secreto').equals(CLAVE)).toBe(false);
  });
});

describe('permiso de autorización: verificación', () => {
  it('válido para este vendedor, estas líneas y dentro de los 5 minutos', () => {
    const { permiso, datos } = permisoValido();
    const r = verificarPermiso(permiso, esperado(), CLAVE);
    expect(r).toMatchObject({ valido: true, datos: { v: 1, sol: VENDEDOR, aut: ADMIN, vence: AHORA + VIGENCIA_PERMISO_MS } });
    expect(datos.vence - AHORA).toBe(5 * 60_000);
  });

  it('(b) no sirve para otras líneas: otro producto, otra cantidad, otro precio final, una línea de más', () => {
    const { permiso } = permisoValido();
    const otras = [
      [{ id_producto: 8, cantidad: 2, precio_final: 7 }, LINEAS[1]],
      [{ id_producto: 7, cantidad: 3, precio_final: 7 }, LINEAS[1]],
      [{ id_producto: 7, cantidad: 2, precio_final: 6.99 }, LINEAS[1]],
      [...LINEAS, { id_producto: 11, cantidad: 1, precio_final: 1 }],
      [LINEAS[0]],
    ];
    for (const lineas of otras) {
      expect(verificarPermiso(permiso, esperado({ huella: huellaLineas(lineas) }), CLAVE)).toEqual({ valido: false, motivo: 'otras_lineas' });
    }
  });

  it('el orden de las líneas en el carrito no importa', () => {
    const { permiso } = permisoValido();
    expect(verificarPermiso(permiso, esperado({ huella: huellaLineas([LINEAS[1], LINEAS[0]]) }), CLAVE).valido).toBe(true);
  });

  it('(b) no sirve para otro solicitante', () => {
    const { permiso } = permisoValido();
    expect(verificarPermiso(permiso, esperado({ solicitante: 5 }), CLAVE)).toEqual({ valido: false, motivo: 'otro_solicitante' });
  });

  it('(b) vencido: a los 5 minutos exactos ya no vale', () => {
    const { permiso } = permisoValido();
    expect(verificarPermiso(permiso, esperado({ ahora: AHORA + VIGENCIA_PERMISO_MS - 1 }), CLAVE).valido).toBe(true);
    expect(verificarPermiso(permiso, esperado({ ahora: AHORA + VIGENCIA_PERMISO_MS }), CLAVE)).toEqual({ valido: false, motivo: 'vencido' });
  });

  it('(c) manipulado: cambiar el solicitante, el vencimiento o la huella dentro de los datos rompe la firma', () => {
    const { permiso, datos } = permisoValido();
    const firma = permiso.split('.')[1];
    const cambios = [
      { ...datos, sol: 5 },
      { ...datos, vence: datos.vence + 3_600_000 },
      { ...datos, h: huellaLineas([{ id_producto: 7, cantidad: 2, precio_final: 1 }]) },
      { ...datos, aut: 99 },
    ];
    for (const d of cambios) {
      const falso = `${Buffer.from(JSON.stringify(d)).toString('base64url')}.${firma}`;
      expect(verificarPermiso(falso, esperado({ solicitante: d.sol, huella: d.h }), CLAVE)).toEqual({ valido: false, motivo: 'firma' });
    }
  });

  it('(c) firma alterada, de otro largo, o firmado con otro secreto: firma inválida', () => {
    const { permiso, datos } = permisoValido();
    const [parte, firma] = permiso.split('.');
    const alterada = `${parte}.${firma.slice(0, -2)}${firma.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verificarPermiso(alterada, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'firma' });
    expect(verificarPermiso(`${parte}.${firma.slice(0, 10)}`, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'firma' });
    const ajeno = firmarPermiso(datos, claveDePermiso('otro-secreto'));
    expect(verificarPermiso(ajeno, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'firma' });
  });

  it('ausente o mal formado: nunca lanza', () => {
    for (const v of [undefined, null, '', '   ', 42, {}]) {
      expect(verificarPermiso(v, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'ausente' });
    }
    for (const v of ['abc', 'a.b.c', 'a b.c', 'ñ.ñ', `${'a'.repeat(1001)}.b`]) {
      expect(verificarPermiso(v, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'mal_formado' });
    }
    // Firmado bien pero con datos que no son JSON o con otra versión.
    const noJson = Buffer.from('no-json').toString('base64url');
    const firmaNoJson = createHmac('sha256', CLAVE).update(noJson).digest('base64url');
    expect(verificarPermiso(`${noJson}.${firmaNoJson}`, esperado(), CLAVE)).toEqual({ valido: false, motivo: 'mal_formado' });
    const { datos } = permisoValido();
    expect(verificarPermiso(firmarPermiso({ ...datos, v: 2 }, CLAVE), esperado(), CLAVE)).toEqual({ valido: false, motivo: 'version' });
  });

  it('dos permisos para el mismo carrito son distintos (uso único por firma)', () => {
    expect(permisoValido().permiso).not.toBe(permisoValido().permiso);
  });
});
