import { BadRequestException, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ControlRebajaService } from './control-rebaja.service';
import { huellaLineas } from './permiso-autorizacion';
import { HashUtil } from '../util/jwt/hash.util';

const CONTRASENA = 'Secreta-123';

function crear(opciones: { valores?: Record<string, string | null>; filasUsuario?: any[]; obtenerFalla?: boolean } = {}) {
  const valores: Record<string, string | null> = { ...(opciones.valores ?? {}) };
  const config = {
    obtenerVarias: jest.fn(async (claves: string[]) => {
      if (opciones.obtenerFalla) throw new Error('sin conexión');
      return Object.fromEntries(claves.map((c) => [c, valores[c] ?? null]));
    }),
    guardar: jest.fn(async (clave: string, valor: string) => {
      valores[clave] = valor;
    }),
  };
  const dataSource = { query: jest.fn(async (_sql: string, _params?: unknown[]) => opciones.filasUsuario ?? []) };
  const registrar = jest.fn(async (_evento: any) => undefined);
  const bitacora = {
    registrar,
    registrarCon: jest.fn(async (fabrica: () => any) => {
      const r = fabrica();
      for (const e of Array.isArray(r) ? r : [r]) if (e) await registrar(e);
    }),
  };
  const servicio = new ControlRebajaService(config as never, dataSource as never, bitacora as never);
  return { servicio, config, dataSource, bitacora, valores };
}

let log: jest.SpyInstance;
let aviso: jest.SpyInstance;
beforeAll(() => {
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('ControlRebajaService · configuración', () => {
  it('sin claves: registrar, 10 %, bajo costo (ninguna venta cambia al desplegar)', async () => {
    const { servicio } = crear();
    await expect(servicio.configuracion()).resolves.toEqual({ modo: 'registrar', tope_pct: 10, bajo_costo: true });
  });

  it('para la venta: si leer falla, null y un aviso (la venta sigue como hoy); nunca lanza', async () => {
    const { servicio } = crear({ obtenerFalla: true });
    await expect(servicio.configuracionParaVenta()).resolves.toBeNull();
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('la venta sigue sin control'));
  });

  it('guardar: solo escribe lo que cambió y lo anota en la bitácora con antes y después', async () => {
    const { servicio, config, bitacora } = crear();
    const admin = { id_usuario: 1, rol: 'admin' } as never;

    const r = await servicio.guardar({ modo: 'autorizar', tope_pct: '15', bajo_costo: true }, admin);

    expect(r).toEqual({ modo: 'autorizar', tope_pct: 15, bajo_costo: true });
    expect(config.guardar.mock.calls).toEqual([
      ['control_rebaja_modo', 'autorizar'],
      ['rebaja_max_pct_vendedor', '15'],
    ]);
    expect(bitacora.registrar).toHaveBeenCalledTimes(1);
    expect(bitacora.registrar.mock.calls[0][0]).toEqual({
      accion: 'configuracion.control_rebaja',
      id_usuario: 1,
      rol: 'admin',
      entidad: 'configuracion',
      antes: { modo: 'registrar', tope_pct: 10, bajo_costo: true },
      despues: { modo: 'autorizar', tope_pct: 15, bajo_costo: true },
    });

    // Los nombres de campo no chocan con el filtro de secretos de la bitácora.
    const campos = Object.keys(bitacora.registrar.mock.calls[0][0].despues);
    expect(campos.some((c) => /clave|password|passw|contrase|secret|token|key|llave/i.test(c))).toBe(false);
  });

  it('guardar sin cambios no escribe ni anota; bajo_costo=false se guarda como texto', async () => {
    const { servicio, config, bitacora } = crear();
    await servicio.guardar({ modo: 'registrar' });
    expect(config.guardar).not.toHaveBeenCalled();
    expect(bitacora.registrar).not.toHaveBeenCalled();

    await servicio.guardar({ bajo_costo: false });
    expect(config.guardar).toHaveBeenCalledWith('control_bajo_costo', 'false');
  });

  it('guardar rechaza con 400 un modo, tope o bajo_costo inválido, sin escribir nada', async () => {
    const { servicio, config } = crear();
    for (const cuerpo of [{ modo: 'bloquear' }, { tope_pct: 120 }, { tope_pct: -1 }, { tope_pct: 'diez' }, { tope_pct: '' }, { bajo_costo: 'si' }]) {
      await expect(servicio.guardar(cuerpo)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(config.guardar).not.toHaveBeenCalled();
  });
});

describe('ControlRebajaService · administrador que autoriza', () => {
  let hash: string;
  beforeAll(async () => {
    hash = await HashUtil.hashPassword(CONTRASENA);
  });

  it('admin activo con la contraseña correcta: devuelve su id y nombre; busca por correo en minúsculas y solo activos', async () => {
    const { servicio, dataSource } = crear({ filasUsuario: [{ id_usuario: 1, nombre: ' Dueño ', password: hash, rol: 'Administrador' }] });

    await expect(servicio.verificarAdministrador('  DUENO@Ferreteria.pe ', CONTRASENA)).resolves.toEqual({ id_usuario: 1, nombre: 'Dueño' });

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(params).toEqual(['dueno@ferreteria.pe']);
    expect(sql).toContain('u.estado = true');
    expect(sql).toContain('LOWER(u.email) = $1');
  });

  it('contraseña mala, cuenta que no es admin, sin cuenta o sin contraseña: 422 AUTORIZACION_RECHAZADA (nunca 401)', async () => {
    const casos = [
      () => crear({ filasUsuario: [{ id_usuario: 1, nombre: 'Dueño', password: hash, rol: 'admin' }] }).servicio.verificarAdministrador('d@x.pe', 'otra'),
      () => crear({ filasUsuario: [{ id_usuario: 4, nombre: 'Cajero', password: hash, rol: 'caja' }] }).servicio.verificarAdministrador('c@x.pe', CONTRASENA),
      () => crear({ filasUsuario: [] }).servicio.verificarAdministrador('nadie@x.pe', CONTRASENA),
      () => crear({ filasUsuario: [{ id_usuario: 2, nombre: 'Google', password: null, rol: 'admin' }] }).servicio.verificarAdministrador('g@x.pe', CONTRASENA),
    ];
    for (const caso of casos) {
      const error = await caso().catch((e: any) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ codigo: 'AUTORIZACION_RECHAZADA' });
    }
  });

  it('sin cuenta compara igual contra el hash de relleno (el tiempo no delata qué correos existen)', async () => {
    const relleno = jest.spyOn(HashUtil, 'compararSinCuenta');
    const { servicio } = crear({ filasUsuario: [] });
    await servicio.verificarAdministrador('nadie@x.pe', CONTRASENA).catch(() => undefined);
    expect(relleno).toHaveBeenCalledWith(CONTRASENA);
    relleno.mockRestore();
  });

  it('sin correo o sin contraseña: 422 sin consultar la base', async () => {
    const { servicio, dataSource } = crear();
    await expect(servicio.verificarAdministrador('', CONTRASENA)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(servicio.verificarAdministrador('d@x.pe', undefined)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('la contraseña no aparece en ningún log ni en el mensaje de error', async () => {
    log.mockClear();
    aviso.mockClear();
    const { servicio } = crear({ filasUsuario: [{ id_usuario: 1, nombre: 'Dueño', password: hash, rol: 'admin' }] });
    const error = await servicio.verificarAdministrador('d@x.pe', 'Clave-Equivocada-987').catch((e) => e);
    const todo = JSON.stringify([error.getResponse(), error.message, log.mock.calls, aviso.mock.calls]);
    expect(todo).not.toContain('Clave-Equivocada-987');
  });
});

describe('ControlRebajaService · permiso (uso único, reloj)', () => {
  const huella = huellaLineas([{ id_producto: 7, cantidad: 1, precio_final: 7 }]);

  it('emite un permiso de 5 minutos que verifica para el mismo vendedor y líneas', () => {
    const { servicio } = crear();
    servicio.ahora = () => 1_000_000;
    const { permiso, vence } = servicio.emitirPermiso(4, 1, huella);
    expect(vence).toBe(1_000_000 + 300_000);
    expect(servicio.verificarPermiso(permiso, 4, huella)).toMatchObject({ valido: true, datos: { sol: 4, aut: 1 } });
    expect(servicio.verificarPermiso(permiso, 5, huella)).toEqual({ valido: false, motivo: 'otro_solicitante' });
    servicio.ahora = () => 1_000_000 + 300_000;
    expect(servicio.verificarPermiso(permiso, 4, huella)).toEqual({ valido: false, motivo: 'vencido' });
  });

  it('marcado como usado (tras guardar una venta) ya no sirve para otra', () => {
    const { servicio } = crear();
    const { permiso, vence } = servicio.emitirPermiso(4, 1, huella);
    const r = servicio.verificarPermiso(permiso, 4, huella);
    if (!r.valido) throw new Error('debía ser válido');
    servicio.marcarUsado(r.firma, vence);
    expect(servicio.verificarPermiso(permiso, 4, huella)).toEqual({ valido: false, motivo: 'usado' });
    // Otro permiso para el mismo carrito sí vale.
    expect(servicio.verificarPermiso(servicio.emitirPermiso(4, 1, huella).permiso, 4, huella).valido).toBe(true);
  });

  it('un permiso de otro servidor (otro secreto) no vale', () => {
    const { servicio } = crear();
    const ajeno = 'eyJ2IjoxfQ.' + 'A'.repeat(43);
    expect(servicio.verificarPermiso(ajeno, 4, huella)).toEqual({ valido: false, motivo: 'firma' });
  });
});

describe('ControlRebajaService · freno de intentos fallidos (solo fallos, por solicitante y por correo)', () => {
  const ADMIN_ROW = { id_usuario: 1, nombre: 'Dueño', password: 'hash-guardado', rol: 'admin' };
  let comparar: jest.SpyInstance;
  let relleno: jest.SpyInstance;

  beforeEach(() => {
    // Sin bcrypt real: la contraseña buena es «buena».
    comparar = jest.spyOn(HashUtil, 'comparePassword').mockImplementation(async (plano: string) => plano === 'buena');
    relleno = jest.spyOn(HashUtil, 'compararSinCuenta').mockResolvedValue(false);
  });
  afterEach(() => {
    comparar.mockRestore();
    relleno.mockRestore();
  });

  function armar(filas: any[] = [ADMIN_ROW]) {
    const base = crear({ filasUsuario: filas });
    let ahora = 1_000_000;
    base.servicio.ahora = () => ahora;
    return { ...base, avanzar: (ms: number) => { ahora += ms; } };
  }
  const intentar = (servicio: ControlRebajaService, solicitante: number, clave = 'mala', correo = 'dueno@x.pe') =>
    servicio.verificarAdministrador(correo, clave, solicitante).then(() => 'ok', (e: any) => e);

  it('5 fallos en 5 min del mismo solicitante: el 6.º responde 429 AUTORIZACION_BLOQUEADA sin consultar ni comparar', async () => {
    const { servicio, dataSource } = armar();
    for (let i = 0; i < 5; i++) expect(await intentar(servicio, 4)).toBeInstanceOf(UnprocessableEntityException);
    dataSource.query.mockClear();
    comparar.mockClear();

    const error = await intentar(servicio, 4, 'buena');

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ codigo: 'AUTORIZACION_BLOQUEADA', reintentarEnSeg: 300 });
    expect(error.getResponse().message).toBe('Demasiados intentos fallidos de autorización. Espere 5 minutos antes de volver a intentarlo.');
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(comparar).not.toHaveBeenCalled();
  });

  it('los aciertos no cuentan y un acierto borra los fallos de ese solicitante', async () => {
    const { servicio } = armar();
    for (let i = 0; i < 10; i++) expect(await intentar(servicio, 4, 'buena')).toBe('ok');
    for (let i = 0; i < 4; i++) await intentar(servicio, 4);
    expect(await intentar(servicio, 4, 'buena')).toBe('ok');
    // Tras el acierto el contador vuelve a cero: 4 fallos más todavía no bloquean.
    for (let i = 0; i < 4; i++) expect(await intentar(servicio, 4)).toBeInstanceOf(UnprocessableEntityException);
    expect(await intentar(servicio, 4, 'buena')).toBe('ok');
  });

  it('otro solicitante no queda bloqueado por los fallos del primero', async () => {
    const { servicio } = armar();
    for (let i = 0; i < 5; i++) await intentar(servicio, 4);
    expect((await intentar(servicio, 4, 'buena')).getStatus()).toBe(429);
    expect(await intentar(servicio, 5, 'buena')).toBe('ok');
  });

  it('10 fallos en 15 min contra un correo lo bloquean aunque vengan de solicitantes distintos (también si el correo no existe)', async () => {
    const existe = armar();
    for (let i = 0; i < 10; i++) await intentar(existe.servicio, 100 + i);
    const error = await intentar(existe.servicio, 200, 'buena');
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse().codigo).toBe('AUTORIZACION_BLOQUEADA');
    // Otro correo sigue disponible para ese mismo solicitante nuevo.
    expect(await intentar(existe.servicio, 200, 'mala', 'otro@x.pe')).toBeInstanceOf(UnprocessableEntityException);

    // Un correo inexistente se bloquea igual: la respuesta no revela si existe.
    const inexistente = armar([]);
    for (let i = 0; i < 10; i++) expect(await intentar(inexistente.servicio, 100 + i, 'mala', 'nadie@x.pe')).toBeInstanceOf(UnprocessableEntityException);
    const bloqueo = await intentar(inexistente.servicio, 300, 'mala', 'nadie@x.pe');
    expect(bloqueo.getStatus()).toBe(429);
    expect(bloqueo.getResponse()).toMatchObject({ codigo: 'AUTORIZACION_BLOQUEADA', reintentarEnSeg: 900 });
  });

  it('el bloqueo vence solo', async () => {
    const { servicio, avanzar } = armar();
    for (let i = 0; i < 5; i++) await intentar(servicio, 4);
    avanzar(4 * 60_000);
    const aun = await intentar(servicio, 4, 'buena');
    expect(aun.getStatus()).toBe(429);
    expect(aun.getResponse().message).toContain('Espere 1 minuto');
    avanzar(60_000);
    expect(await intentar(servicio, 4, 'buena')).toBe('ok');

    const correo = armar();
    for (let i = 0; i < 10; i++) await intentar(correo.servicio, 100 + i);
    correo.avanzar(15 * 60_000);
    expect(await intentar(correo.servicio, 300, 'buena')).toBe('ok');
  });

  it('un error de la base no cuenta como intento fallido', async () => {
    const { servicio, dataSource } = armar();
    dataSource.query.mockRejectedValue(new Error('sin conexión'));
    for (let i = 0; i < 6; i++) expect(await intentar(servicio, 4)).toBeInstanceOf(Error);
    dataSource.query.mockResolvedValue([ADMIN_ROW]);
    expect(await intentar(servicio, 4, 'buena')).toBe('ok');
  });
});
