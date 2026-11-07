import { HttpException } from '@nestjs/common';
import { CajaSesionBussnies, montoInicialDeApertura } from './caja-sesion.bussnies';

/**
 * Apertura de turno (T3a): el efectivo inicial siempre queda numérico (nunca NULL), «sin efectivo»
 * guarda 0.00, los montos inválidos responden 400 con CAJA_MONTO_INICIAL_INVALIDO y la respuesta
 * trae el sugerido (último conteo de esa caja) y la diferencia contra lo que puso el cajero.
 */
const usuario = { id_usuario: 7, nombre: 'Rosa', email: 'r@x.pe', rol: 'caja', permisos: [] };

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
    expect(await servicio.disponibles()).toEqual({ items });
  });
});

describe('montoInicialDeApertura', () => {
  it('acepta un número en texto', () => {
    expect(montoInicialDeApertura({ monto_inicial: '25.50' as any }).aNumero()).toBe(25.5);
  });
});
