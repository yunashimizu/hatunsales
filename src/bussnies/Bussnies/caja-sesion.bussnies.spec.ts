import { HttpException } from '@nestjs/common';
import { CajaSesionBussnies, montoInicialDeApertura } from './caja-sesion.bussnies';

/**
 * Apertura de turno (T3a): el efectivo inicial siempre queda numérico (nunca NULL), «sin efectivo»
 * guarda 0.00, los montos inválidos responden 400 con CAJA_MONTO_INICIAL_INVALIDO y la respuesta
 * trae el sugerido (último conteo de esa caja) y la diferencia contra lo que puso el cajero.
 */
const usuario = { id_usuario: 7, nombre: 'Rosa', email: 'r@x.pe', rol: 'caja', permisos: [] };
const admin = { id_usuario: 1, nombre: 'Moisés', email: 'm@x.pe', rol: 'admin', permisos: [] };

function armar(sugerido: number | null = null) {
  const abrir = jest.fn(async (p: { idCaja: number; idUsuario: number; montoInicial?: number | null }) => ({
    id_apertura: 55,
    id_caja: p.idCaja,
    caja_nombre: 'Caja 1',
    id_sucursal: 1,
    sucursal_nombre: 'Principal',
    id_usuario: p.idUsuario,
    fecha: '2026-11-06T13:00:00.000Z',
    monto_inicial: p.montoInicial ?? null,
  }));
  const repo = {
    cajaExiste: jest.fn().mockResolvedValue(true),
    sugeridoInicial: jest.fn().mockResolvedValue(sugerido),
    abrir,
    listarDisponibles: jest.fn(),
    ocupantesDeCajas: jest.fn().mockResolvedValue(new Map()),
    listarLocales: jest.fn().mockResolvedValue([]),
    crearCaja: jest.fn(),
    actualizarCaja: jest.fn(),
  };
  const servicio = new CajaSesionBussnies(repo as any, {} as any);
  return { servicio, repo, abrir };
}

async function codigoDe(promesa: Promise<unknown>): Promise<{ estado: number; codigo?: string }> {
  try {
    await promesa;
  } catch (e) {
    const http = e as HttpException;
    const cuerpo = http.getResponse() as { codigo?: string };
    return { estado: http.getStatus(), codigo: cuerpo?.codigo };
  }
  throw new Error('Se esperaba un error HTTP');
}

describe('CajaSesionBussnies.abrir · efectivo inicial', () => {
  it('sin monto guarda 0.00 explícito (compatibilidad con el front viejo)', async () => {
    const { servicio, abrir } = armar();
    const r = await servicio.abrir({ id_caja: 1 } as any, usuario);
    expect(abrir).toHaveBeenCalledWith({ idCaja: 1, idUsuario: 7, montoInicial: 0 });
    expect(r.monto_inicial).toBe(0);
  });

  it('monto_inicial null o vacío también es 0', async () => {
    const { servicio, abrir } = armar();
    await servicio.abrir({ id_caja: 1, monto_inicial: null } as any, usuario);
    expect(abrir).toHaveBeenLastCalledWith(expect.objectContaining({ montoInicial: 0 }));
  });

  it('«sin efectivo» guarda 0 e ignora el monto enviado', async () => {
    const { servicio, abrir } = armar();
    await servicio.abrir({ id_caja: 1, sin_efectivo: true, monto_inicial: 250 } as any, usuario);
    expect(abrir).toHaveBeenCalledWith({ idCaja: 1, idUsuario: 7, montoInicial: 0 });
  });

  it('guarda el monto indicado con 2 decimales', async () => {
    const { servicio, abrir } = armar();
    await servicio.abrir({ id_caja: 1, monto_inicial: 150.5 } as any, usuario);
    expect(abrir).toHaveBeenCalledWith({ idCaja: 1, idUsuario: 7, montoInicial: 150.5 });
  });

  it('acepta el máximo y rechaza lo que lo supera', async () => {
    const { servicio, abrir } = armar();
    await servicio.abrir({ id_caja: 1, monto_inicial: 9_999_999.99 } as any, usuario);
    expect(abrir).toHaveBeenCalledTimes(1);

    const r = await codigoDe(servicio.abrir({ id_caja: 1, monto_inicial: 10_000_000 } as any, usuario));
    expect(r).toEqual({ estado: 400, codigo: 'CAJA_MONTO_INICIAL_INVALIDO' });
    expect(abrir).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['negativo', -1],
    ['NaN', NaN],
    ['texto', 'abc'],
    ['más de 2 decimales', 10.123],
    ['infinito', Infinity],
  ])('monto %s → 400 CAJA_MONTO_INICIAL_INVALIDO y no abre el turno', async (_nombre, monto) => {
    const { servicio, abrir, repo } = armar();
    const r = await codigoDe(servicio.abrir({ id_caja: 1, monto_inicial: monto } as any, usuario));
    expect(r).toEqual({ estado: 400, codigo: 'CAJA_MONTO_INICIAL_INVALIDO' });
    expect(abrir).not.toHaveBeenCalled();
    expect(repo.cajaExiste).not.toHaveBeenCalled();
  });

  it('con «sin efectivo» un monto inválido no estorba (se ignora)', async () => {
    const { servicio, abrir } = armar();
    await servicio.abrir({ id_caja: 1, sin_efectivo: true, monto_inicial: -50 } as any, usuario);
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ montoInicial: 0 }));
  });
});

describe('CajaSesionBussnies.abrir · sugerido y diferencia', () => {
  it('responde sugerido_inicial y diferencia_sugerido = monto - sugerido', async () => {
    const { servicio } = armar(120);
    const r = await servicio.abrir({ id_caja: 1, monto_inicial: 100 } as any, usuario);
    expect(r.sugerido_inicial).toBe(120);
    expect(r.diferencia_sugerido).toBe(-20);
    expect(r.id_apertura).toBe(55);
  });

  it('monto igual al sugerido → diferencia 0', async () => {
    const { servicio } = armar(80.1);
    const r = await servicio.abrir({ id_caja: 1, monto_inicial: 80.1 } as any, usuario);
    expect(r.diferencia_sugerido).toBe(0);
  });

  it('«sin efectivo» con sugerido: la diferencia es -sugerido', async () => {
    const { servicio } = armar(60);
    const r = await servicio.abrir({ id_caja: 1, sin_efectivo: true } as any, usuario);
    expect(r.diferencia_sugerido).toBe(-60);
  });

  it('sin sugerido (primera apertura de la caja) → ambos null', async () => {
    const { servicio } = armar(null);
    const r = await servicio.abrir({ id_caja: 1, monto_inicial: 10 } as any, usuario);
    expect(r.sugerido_inicial).toBeNull();
    expect(r.diferencia_sugerido).toBeNull();
  });

  it('si el sugerido no se puede leer, el turno se abre igual', async () => {
    const { servicio, repo } = armar();
    repo.sugeridoInicial.mockRejectedValue(new Error('columna inexistente'));
    const r = await servicio.abrir({ id_caja: 1, monto_inicial: 10 } as any, usuario);
    expect(r.sugerido_inicial).toBeNull();
    expect(r.diferencia_sugerido).toBeNull();
  });
});

describe('CajaSesionBussnies.disponibles', () => {
  it('devuelve las cajas con su sugerido_inicial tal cual lo entrega el repositorio', async () => {
    const { servicio, repo } = armar();
    const items = [
      { id_caja: 1, nombre: 'Caja 1', id_sucursal: 1, sucursal_nombre: 'Principal', ocupada: false, sugerido_inicial: 45.5 },
      { id_caja: 2, nombre: 'Caja 2', id_sucursal: null, sucursal_nombre: null, ocupada: true, sugerido_inicial: null },
    ];
    repo.listarDisponibles.mockResolvedValue(items);
    expect(await servicio.disponibles()).toEqual({
      items: items.map((c) => ({ ...c, ocupada_por: null, abierta_en: null, es_mia: false })),
      sucursales: [],
    });
  });

  const cajasLurin = [
    { id_caja: 1, nombre: 'Caja 1', id_sucursal: 1, sucursal_nombre: 'Lurín', ocupada: false, sugerido_inicial: 150 },
    { id_caja: 2, nombre: 'Caja 2', id_sucursal: 1, sucursal_nombre: 'Lurín', ocupada: true, sugerido_inicial: null },
    { id_caja: 3, nombre: 'Caja 3', id_sucursal: 2, sucursal_nombre: 'Pachacámac', ocupada: true, sugerido_inicial: null },
  ];

  it('mezcla quién tiene cada caja y marca es_mia para el turno del usuario que consulta', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajasLurin);
    repo.ocupantesDeCajas.mockResolvedValue(
      new Map([
        [2, { id_usuario: 7, usuario_nombre: 'Rosa Quispe', abierta_en: '2026-11-09T13:10:00.000Z' }],
        [3, { id_usuario: 9, usuario_nombre: 'Ana Quispe', abierta_en: '2026-11-09T13:05:00.000Z' }],
      ]),
    );
    const r = await servicio.disponibles(usuario);
    expect(r.items[0]).toEqual({ ...cajasLurin[0], ocupada_por: null, abierta_en: null, es_mia: false });
    expect(r.items[1]).toEqual({
      ...cajasLurin[1],
      ocupada_por: 'Rosa Quispe',
      abierta_en: '2026-11-09T13:10:00.000Z',
      es_mia: true,
    });
  });

  it('el ocupante de otra persona trae su nombre y hora, sin es_mia', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajasLurin);
    repo.ocupantesDeCajas.mockResolvedValue(
      new Map([[3, { id_usuario: 9, usuario_nombre: 'Ana Quispe', abierta_en: '2026-11-09T13:05:00.000Z' }]]),
    );
    const r = await servicio.disponibles(usuario);
    expect(r.items[2]).toEqual({
      ...cajasLurin[2],
      ocupada_por: 'Ana Quispe',
      abierta_en: '2026-11-09T13:05:00.000Z',
      es_mia: false,
    });
    // La caja 2 está ocupada pero la consulta no trajo su ocupante: sigue saliendo, sin nombre.
    expect(r.items[1]).toEqual({ ...cajasLurin[1], ocupada_por: null, abierta_en: null, es_mia: false });
  });

  it('si la consulta de ocupantes falla, responde las cajas igual que antes', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajasLurin);
    repo.ocupantesDeCajas.mockRejectedValue(new Error('column u.apellido_paterno does not exist'));
    const r = await servicio.disponibles(usuario);
    expect(r.items).toEqual(cajasLurin.map((c) => ({ ...c, ocupada_por: null, abierta_en: null, es_mia: false })));
  });
});

describe('CajaSesionBussnies.disponibles · locales y cajas desactivadas (Fase 7)', () => {
  const locales = [
    { id_sucursal: 1, nombre: 'Lurín', direccion: 'Av. Lima 123' },
    { id_sucursal: 2, nombre: 'Pachacámac', direccion: null },
    { id_sucursal: 3, nombre: 'Villa', direccion: null },
  ];
  const cajas = [
    { id_caja: 1, nombre: 'Caja 1', id_sucursal: 1, sucursal_nombre: 'Lurín', ocupada: false, activa: true, sugerido_inicial: null },
    { id_caja: 2, nombre: 'Caja 2', id_sucursal: 1, sucursal_nombre: 'Lurín', ocupada: false, activa: false, sugerido_inicial: null },
  ];

  it('suma todos los locales (también los que no tienen cajas)', async () => {
    const { servicio, repo } = armar();
    repo.listarLocales.mockResolvedValue(locales);
    repo.listarDisponibles.mockResolvedValue(cajas);
    const r = await servicio.disponibles(admin);
    expect(r.sucursales).toEqual(locales);
    expect(r.sucursales.map((l) => l.id_sucursal)).toContain(3);
  });

  it('si la consulta de locales falla, responde sucursales: [] y las cajas igual', async () => {
    const { servicio, repo } = armar();
    repo.listarLocales.mockRejectedValue(new Error('relation "sucursales" does not exist'));
    repo.listarDisponibles.mockResolvedValue(cajas);
    const r = await servicio.disponibles(admin);
    expect(r.sucursales).toEqual([]);
    expect(r.items).toHaveLength(2);
  });

  it('quien no es admin no recibe las cajas desactivadas', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajas);
    const r = await servicio.disponibles(usuario);
    expect(r.items.map((c) => c.id_caja)).toEqual([1]);
  });

  it('el admin las recibe todas, con activa false en la desactivada', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajas);
    const r = await servicio.disponibles(admin);
    expect(r.items.map((c) => [c.id_caja, c.activa])).toEqual([[1, true], [2, false]]);
  });

  it('un rol con alias de admin (superadmin) cuenta como admin', async () => {
    const { servicio, repo } = armar();
    repo.listarDisponibles.mockResolvedValue(cajas);
    const r = await servicio.disponibles({ ...admin, rol: 'superadmin' });
    expect(r.items).toHaveLength(2);
  });
});

describe('CajaSesionBussnies.crearCaja (Fase 7)', () => {
  const creada = { id_caja: 9, nombre: 'Caja 1', id_sucursal: 2, sucursal_nombre: 'Pachacámac', ocupada: false, activa: true, sugerido_inicial: null };

  it('crea con nombre por defecto (vacío) y devuelve la caja con la forma de disponibles', async () => {
    const { servicio, repo } = armar();
    repo.crearCaja.mockResolvedValue(creada);
    const r = await servicio.crearCaja({ id_sucursal: 2, nombre: '   ' }, admin);
    expect(repo.crearCaja).toHaveBeenCalledWith({ idSucursal: 2, nombre: null });
    expect(r).toEqual({ ...creada, ocupada_por: null, abierta_en: null, es_mia: false });
  });

  it('recorta el nombre indicado', async () => {
    const { servicio, repo } = armar();
    repo.crearCaja.mockResolvedValue(creada);
    await servicio.crearCaja({ id_sucursal: 2, nombre: '  Caja rápida ' }, admin);
    expect(repo.crearCaja).toHaveBeenCalledWith({ idSucursal: 2, nombre: 'Caja rápida' });
  });

  it('un nombre de más de 100 caracteres → 400 y no llega al repositorio', async () => {
    const { servicio, repo } = armar();
    const r = await codigoDe(servicio.crearCaja({ id_sucursal: 2, nombre: 'x'.repeat(101) }, admin));
    expect(r.estado).toBe(400);
    expect(repo.crearCaja).not.toHaveBeenCalled();
  });

  it('local inexistente → 404 ENTIDAD_NO_ENCONTRADA', async () => {
    const { servicio, repo } = armar();
    repo.crearCaja.mockRejectedValue(new Error('SUCURSAL_NO_ENCONTRADA'));
    expect(await codigoDe(servicio.crearCaja({ id_sucursal: 99 }, admin))).toEqual({
      estado: 404,
      codigo: 'ENTIDAD_NO_ENCONTRADA',
    });
  });

  it('id_sucursal inválido → 404 sin consultar', async () => {
    const { servicio, repo } = armar();
    expect(await codigoDe(servicio.crearCaja({ id_sucursal: 0 }, admin))).toEqual({
      estado: 404,
      codigo: 'ENTIDAD_NO_ENCONTRADA',
    });
    expect(repo.crearCaja).not.toHaveBeenCalled();
  });

  it('nombre repetido en el local → 409 CAJA_NOMBRE_REPETIDO', async () => {
    const { servicio, repo } = armar();
    repo.crearCaja.mockRejectedValue(new Error('CAJA_NOMBRE_REPETIDO'));
    expect(await codigoDe(servicio.crearCaja({ id_sucursal: 2, nombre: 'caja 1' }, admin))).toEqual({
      estado: 409,
      codigo: 'CAJA_NOMBRE_REPETIDO',
    });
  });
});

describe('CajaSesionBussnies.actualizarCaja (Fase 7)', () => {
  const caja = { id_caja: 4, nombre: 'Caja 4', id_sucursal: 1, sucursal_nombre: 'Lurín', ocupada: false, activa: true, sugerido_inicial: null };

  it('renombrar: recorta y pasa solo el nombre', async () => {
    const { servicio, repo } = armar();
    repo.actualizarCaja.mockResolvedValue({ ...caja, nombre: 'Principal' });
    const r = await servicio.actualizarCaja(4, { nombre: ' Principal ' }, admin);
    expect(repo.actualizarCaja).toHaveBeenCalledWith(4, { nombre: 'Principal' });
    expect(r.nombre).toBe('Principal');
  });

  it('el nombre vacío al renombrar → 400', async () => {
    const { servicio, repo } = armar();
    expect((await codigoDe(servicio.actualizarCaja(4, { nombre: '  ' }, admin))).estado).toBe(400);
    expect(repo.actualizarCaja).not.toHaveBeenCalled();
  });

  it('sin nombre ni activa → 400', async () => {
    const { servicio, repo } = armar();
    expect((await codigoDe(servicio.actualizarCaja(4, {}, admin))).estado).toBe(400);
    expect(repo.actualizarCaja).not.toHaveBeenCalled();
  });

  it('desactivar con turno abierto → 409 CAJA_CON_TURNO_ABIERTO', async () => {
    const { servicio, repo } = armar();
    repo.actualizarCaja.mockRejectedValue(new Error('CAJA_CON_TURNO_ABIERTO'));
    const r = await codigoDe(servicio.actualizarCaja(4, { activa: false }, admin));
    expect(r).toEqual({ estado: 409, codigo: 'CAJA_CON_TURNO_ABIERTO' });
    expect(repo.actualizarCaja).toHaveBeenCalledWith(4, { activa: false });
  });

  it('desactivar sin turno devuelve la caja con activa false', async () => {
    const { servicio, repo } = armar();
    repo.actualizarCaja.mockResolvedValue({ ...caja, activa: false });
    const r = await servicio.actualizarCaja(4, { activa: false }, admin);
    expect(r.activa).toBe(false);
  });

  it('nombre repetido → 409 CAJA_NOMBRE_REPETIDO; caja inexistente → 404', async () => {
    const { servicio, repo } = armar();
    repo.actualizarCaja.mockRejectedValueOnce(new Error('CAJA_NOMBRE_REPETIDO'));
    expect(await codigoDe(servicio.actualizarCaja(4, { nombre: 'Caja 1' }, admin))).toEqual({
      estado: 409,
      codigo: 'CAJA_NOMBRE_REPETIDO',
    });
    repo.actualizarCaja.mockRejectedValueOnce(new Error('CAJA_NO_ENCONTRADA'));
    expect(await codigoDe(servicio.actualizarCaja(77, { activa: true }, admin))).toEqual({
      estado: 404,
      codigo: 'ENTIDAD_NO_ENCONTRADA',
    });
  });
});

describe('CajaSesionBussnies.abrir · caja desactivada (Fase 7)', () => {
  it('abrir una caja desactivada → 409 CAJA_DESACTIVADA', async () => {
    const { servicio, repo } = armar();
    repo.abrir.mockRejectedValue(new Error('CAJA_DESACTIVADA'));
    expect(await codigoDe(servicio.abrir({ id_caja: 3, monto_inicial: 10 } as any, usuario))).toEqual({
      estado: 409,
      codigo: 'CAJA_DESACTIVADA',
    });
  });
});

describe('montoInicialDeApertura', () => {
  it('acepta un número en texto', () => {
    expect(montoInicialDeApertura({ monto_inicial: '25.50' as any }).aNumero()).toBe(25.5);
  });
});
