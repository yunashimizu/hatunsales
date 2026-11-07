import { HttpException } from '@nestjs/common';
import { CajaTurnosBussnies } from './caja-turnos.bussnies';
import type { FilaTurno } from '../../repository/Repository/caja-sesion.repository';
import { Dinero } from '../../caja/dominio/dinero';

/**
 * GET /caja/aperturas: turnos paginados con esperado/contado/diferencia, permisos
 * (admin todo; el resto solo su sede y sus turnos) y turnos viejos con monto_inicial NULL.
 * La base local no tiene ventas ni cajas: repositorios dobles.
 */
const admin = { id_usuario: 1, nombre: 'Ana', email: 'a@x.pe', rol: 'admin', permisos: [] };
const cajero = { id_usuario: 7, nombre: 'Rosa', email: 'r@x.pe', rol: 'caja', permisos: [] };

function turno(extra: Partial<FilaTurno> = {}): FilaTurno {
  return {
    id_apertura: 10,
    id_caja: 1,
    caja_nombre: 'Caja 1',
    id_sucursal: 1,
    sucursal_nombre: 'Principal',
    id_usuario: 7,
    usuario_nombre: 'Rosa Pérez',
    abierta_en: '2026-11-05T13:00:00.000Z',
    cerrada_en: '2026-11-05T22:00:00.000Z',
    monto_inicial: Dinero.deSoles(50),
    monto_conteo: Dinero.deSoles(190),
    cerrada: true,
    ...extra,
  };
}

/** Efectivo vendido: 140 en 'EFECTIVO' (esperado = 50 + 140 = 190). */
const filasEfectivo140 = [
  { fuente: 'venta', id_metodo: 1, nombre: 'EFECTIVO', tipo: 'efectivo', total: Dinero.deSoles(140), cantidad: 3, vuelto: Dinero.CERO },
] as any[];

function armar(opciones: { filas?: FilaTurno[]; total?: number; sedes?: (number | null)[]; sucursalCaja?: number | null | undefined } = {}) {
  const filas = opciones.filas ?? [turno()];
  const sesiones = {
    listarTurnos: jest.fn().mockResolvedValue({ filas, total: opciones.total ?? filas.length }),
    sucursalesDeUsuario: jest.fn().mockResolvedValue(opciones.sedes ?? [1]),
    sucursalDeCaja: jest.fn().mockResolvedValue('sucursalCaja' in opciones ? opciones.sucursalCaja : 1),
  };
  const arqueos = { filasEsperado: jest.fn().mockResolvedValue(filasEfectivo140) };
  const servicio = new CajaTurnosBussnies(sesiones as any, arqueos as any);
  return { servicio, sesiones, arqueos };
}

async function falla(promesa: Promise<unknown>): Promise<{ estado: number; codigo?: string }> {
  try {
    await promesa;
  } catch (e) {
    const http = e as HttpException;
    return { estado: http.getStatus(), codigo: (http.getResponse() as { codigo?: string })?.codigo };
  }
  throw new Error('Se esperaba un error HTTP');
}

describe('CajaTurnosBussnies.aperturas · contenido', () => {
  it('turno cerrado: esperado del arqueo, contado del cierre y diferencia', async () => {
    const { servicio, arqueos } = armar();
    const r = await servicio.aperturas(admin, {});
    expect(arqueos.filasEsperado).toHaveBeenCalledWith(10);
    expect(r).toEqual({
      items: [
        {
          id_apertura: 10,
          id_caja: 1,
          caja_nombre: 'Caja 1',
          id_sucursal: 1,
          sucursal_nombre: 'Principal',
          id_usuario: 7,
          usuario_nombre: 'Rosa Pérez',
          abierta_en: '2026-11-05T13:00:00.000Z',
          cerrada_en: '2026-11-05T22:00:00.000Z',
          monto_inicial: 50,
          efectivo_esperado: 190,
          efectivo_contado: 190,
          diferencia: 0,
          estado: 'cerrado',
        },
      ],
      total: 1,
      pagina: 1,
      por_pagina: 20,
    });
  });

  it('diferencia = contado - esperado (faltante negativo)', async () => {
    const { servicio } = armar({ filas: [turno({ monto_conteo: Dinero.deSoles(185.5) })] });
    const r = await servicio.aperturas(admin, {});
    expect(r.items[0].diferencia).toBe(-4.5);
  });

  it('turno abierto: sin cerrada_en, contado ni diferencia, pero con esperado', async () => {
    const { servicio } = armar({ filas: [turno({ cerrada: false, cerrada_en: null, monto_conteo: null })] });
    const [item] = (await servicio.aperturas(admin, {})).items;
    expect(item.estado).toBe('abierto');
    expect(item.cerrada_en).toBeNull();
    expect(item.efectivo_contado).toBeNull();
    expect(item.diferencia).toBeNull();
    expect(item.efectivo_esperado).toBe(190);
  });

  it('cerrado sin conteo guardado: contado y diferencia null', async () => {
    const { servicio } = armar({ filas: [turno({ monto_conteo: null })] });
    const [item] = (await servicio.aperturas(admin, {})).items;
    expect(item.estado).toBe('cerrado');
    expect(item.efectivo_contado).toBeNull();
    expect(item.diferencia).toBeNull();
  });

  it('turno viejo con monto_inicial NULL: sigue null (no 0) y el esperado lo toma como 0', async () => {
    const { servicio } = armar({ filas: [turno({ monto_inicial: null, monto_conteo: Dinero.deSoles(140) })] });
    const [item] = (await servicio.aperturas(admin, {})).items;
    expect(item.monto_inicial).toBeNull();
    expect(item.efectivo_esperado).toBe(140);
    expect(item.diferencia).toBe(0);
  });

  it('si el esperado no se puede calcular (esquema incompleto) queda null y el listado responde', async () => {
    const { servicio, arqueos } = armar();
    arqueos.filasEsperado.mockRejectedValue(new Error('relation "venta_pago" does not exist'));
    const [item] = (await servicio.aperturas(admin, {})).items;
    expect(item.efectivo_esperado).toBeNull();
    expect(item.diferencia).toBeNull();
    expect(item.efectivo_contado).toBe(190);
  });
});

describe('CajaTurnosBussnies.aperturas · paginación y fechas', () => {
  it('por defecto página 1 de 20; calcula el offset', async () => {
    const { servicio, sesiones } = armar({ total: 95 });
    const r = await servicio.aperturas(admin, { pagina: 3, por_pagina: 25 });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.any(Object), { limite: 25, offset: 50 });
    expect(r).toMatchObject({ total: 95, pagina: 3, por_pagina: 25 });
  });

  it('por_pagina se limita a 100 y la página mínima es 1', async () => {
    const { servicio, sesiones } = armar();
    const r = await servicio.aperturas(admin, { por_pagina: 5000, pagina: 0 });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.any(Object), { limite: 100, offset: 0 });
    expect(r).toMatchObject({ pagina: 1, por_pagina: 100 });
  });

  it('pasa las fechas AAAA-MM-DD y los filtros al repositorio', async () => {
    const { servicio, sesiones } = armar();
    await servicio.aperturas(admin, { id_sucursal: 2, id_caja: 3, id_usuario: 9, desde: '2026-11-01', hasta: '2026-11-05' });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(
      { idSucursal: 2, idCaja: 3, idUsuario: 9, desde: '2026-11-01', hasta: '2026-11-05' },
      expect.any(Object),
    );
  });

  it.each([
    ['formato', { desde: '01/11/2026' }],
    ['día inexistente', { hasta: '2026-02-30' }],
    ['desde posterior a hasta', { desde: '2026-11-05', hasta: '2026-11-01' }],
    ['más de 366 días', { desde: '2025-01-01', hasta: '2026-11-05' }],
  ])('fecha inválida (%s) → 400 FECHA_INVALIDA', async (_n, consulta) => {
    const { servicio, sesiones } = armar();
    expect(await falla(servicio.aperturas(admin, consulta))).toEqual({ estado: 400, codigo: 'FECHA_INVALIDA' });
    expect(sesiones.listarTurnos).not.toHaveBeenCalled();
  });

  it('calcula el esperado de todos los turnos de la página', async () => {
    const filas = Array.from({ length: 9 }, (_, i) => turno({ id_apertura: 100 + i }));
    const { servicio, arqueos } = armar({ filas });
    const r = await servicio.aperturas(admin, {});
    expect(r.items).toHaveLength(9);
    expect(arqueos.filasEsperado).toHaveBeenCalledTimes(9);
    expect(r.items.map((i) => i.id_apertura)).toEqual(filas.map((f) => f.id_apertura));
  });
});

describe('CajaTurnosBussnies.aperturas · permisos', () => {
  it('admin: usa los filtros tal cual, sin consultar sedes', async () => {
    const { servicio, sesiones } = armar();
    await servicio.aperturas(admin, { id_usuario: 99, id_sucursal: 5 });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(
      expect.objectContaining({ idUsuario: 99, idSucursal: 5 }),
      expect.any(Object),
    );
    expect(sesiones.sucursalesDeUsuario).not.toHaveBeenCalled();
  });

  it('no admin sin filtros: se fuerza a sus propios turnos', async () => {
    const { servicio, sesiones } = armar();
    await servicio.aperturas(cajero, {});
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idUsuario: 7 }), expect.any(Object));
  });

  it('no admin pidiendo turnos de otro usuario → 403', async () => {
    const { servicio, sesiones } = armar();
    expect(await falla(servicio.aperturas(cajero, { id_usuario: 8 }))).toEqual({ estado: 403, codigo: 'CAJA_TURNO_AJENO' });
    expect(sesiones.listarTurnos).not.toHaveBeenCalled();
  });

  it('no admin pidiendo su propio id_usuario → permitido', async () => {
    const { servicio } = armar();
    await expect(servicio.aperturas(cajero, { id_usuario: 7 })).resolves.toBeDefined();
  });

  it('no admin con una sucursal que no es su sede → 403', async () => {
    const { servicio, sesiones } = armar({ sedes: [1] });
    expect(await falla(servicio.aperturas(cajero, { id_sucursal: 2 }))).toEqual({ estado: 403, codigo: 'CAJA_TURNO_AJENO' });
    expect(sesiones.listarTurnos).not.toHaveBeenCalled();
  });

  it('no admin con su sucursal → permitido', async () => {
    const { servicio } = armar({ sedes: [1, 3] });
    await expect(servicio.aperturas(cajero, { id_sucursal: 3 })).resolves.toBeDefined();
  });

  it('no admin con una caja de otra sede → 403; de su sede → permitido', async () => {
    const ajena = armar({ sedes: [1], sucursalCaja: 2 });
    expect(await falla(ajena.servicio.aperturas(cajero, { id_caja: 40 }))).toEqual({ estado: 403, codigo: 'CAJA_TURNO_AJENO' });
    const propia = armar({ sedes: [1], sucursalCaja: 1 });
    await expect(propia.servicio.aperturas(cajero, { id_caja: 4 })).resolves.toBeDefined();
  });

  it('no admin sin turnos previos no puede filtrar por ninguna sucursal', async () => {
    const { servicio } = armar({ sedes: [] });
    expect(await falla(servicio.aperturas(cajero, { id_sucursal: 1 }))).toMatchObject({ estado: 403 });
  });

  it('usuario sin id en el token → 403', async () => {
    const { servicio } = armar();
    expect(await falla(servicio.aperturas({ ...cajero, id_usuario: 0 }, {}))).toMatchObject({ estado: 403 });
  });

  it('el rol se normaliza: "Administrador" cuenta como admin', async () => {
    const { servicio, sesiones } = armar();
    await servicio.aperturas({ ...cajero, rol: 'Administrador' }, { id_usuario: 99 });
    expect(sesiones.sucursalesDeUsuario).not.toHaveBeenCalled();
  });
});
