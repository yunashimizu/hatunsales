import { HttpException } from '@nestjs/common';
import { CajaTurnosBussnies } from './caja-turnos.bussnies';
import type { FilaTurno } from '../../repository/Repository/caja-sesion.repository';
import { Dinero } from '../../caja/dominio/dinero';
import { hoyLima } from '../../util/fecha-lima';
import * as pdfResumen from '../../util/documentos/resumen-caja-pdf';
import * as logoEmisor from '../../util/documentos/logo-emisor';

/**
 * GET /caja/resumen-sucursales: por sucursal (y «Sin sucursal») turnos, efectivo inicial,
 * ventas por medio de pago, esperado, contado y diferencia. El esperado sale de la misma
 * CalculadoraEsperado del arqueo, turno por turno. Repositorios dobles.
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
    usuario_nombre: 'Rosa',
    abierta_en: '2026-11-05T13:00:00.000Z',
    cerrada_en: '2026-11-05T22:00:00.000Z',
    monto_inicial: Dinero.deSoles(50),
    monto_conteo: Dinero.deSoles(190),
    cerrada: true,
    ...extra,
  };
}

const venta = (id_metodo: number, nombre: string, tipo: string, total: number) =>
  ({ fuente: 'venta', id_metodo, nombre, tipo, total: Dinero.deSoles(total), cantidad: 1, vuelto: Dinero.CERO }) as any;

/** Filas del arqueo por id_apertura. */
const FUENTES: Record<number, any[]> = {
  // Principal, turno 1: efectivo 140 + Yape 60 → esperado efectivo = 50 + 140 = 190
  10: [venta(1, 'EFECTIVO', 'efectivo', 140), venta(2, 'Yape', 'yape', 60)],
  // Principal, turno 2 (abierto): efectivo 30 + crédito 25 → esperado = 20 + 30 = 50
  11: [venta(1, 'EFECTIVO', 'efectivo', 30), venta(9, 'Crédito', 'credito', 25)],
  // Sucursal Norte, turno 3: solo Yape 80, esperado efectivo = 100
  12: [venta(2, 'Yape', 'yape', 80)],
  // Sin sucursal, turno viejo con monto_inicial NULL: efectivo 40
  13: [venta(1, 'EFECTIVO', 'efectivo', 40)],
};

function armar(filas: FilaTurno[], sedes: (number | null)[] = [1]) {
  const sesiones = {
    listarTurnos: jest.fn().mockResolvedValue({ filas, total: filas.length }),
    sucursalesDeUsuario: jest.fn().mockResolvedValue(sedes),
    sucursalDeCaja: jest.fn().mockResolvedValue(1),
  };
  const arqueos = { filasEsperado: jest.fn(async (id: number) => FUENTES[id] ?? []) };
  return { servicio: new CajaTurnosBussnies(sesiones as any, arqueos as any), sesiones, arqueos };
}

const TURNOS: FilaTurno[] = [
  turno({ id_apertura: 10 }),
  turno({ id_apertura: 11, cerrada: false, cerrada_en: null, monto_inicial: Dinero.deSoles(20), monto_conteo: null }),
  turno({
    id_apertura: 12,
    id_caja: 2,
    id_sucursal: 2,
    sucursal_nombre: 'Norte',
    monto_inicial: Dinero.deSoles(100),
    monto_conteo: Dinero.deSoles(95),
  }),
  turno({
    id_apertura: 13,
    id_caja: 3,
    id_sucursal: null,
    sucursal_nombre: null,
    monto_inicial: null,
    monto_conteo: Dinero.deSoles(40),
  }),
];

async function falla(promesa: Promise<unknown>): Promise<{ estado: number; codigo?: string }> {
  try {
    await promesa;
  } catch (e) {
    const http = e as HttpException;
    return { estado: http.getStatus(), codigo: (http.getResponse() as { codigo?: string })?.codigo };
  }
  throw new Error('Se esperaba un error HTTP');
}

describe('CajaTurnosBussnies.resumenSucursales · cuentas', () => {
  it('agrupa por sucursal, «Sin sucursal» al final, y suma con el esperado del arqueo', async () => {
    const { servicio, arqueos } = armar(TURNOS);
    const r = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });

    expect(arqueos.filasEsperado).toHaveBeenCalledTimes(4);
    expect(r.desde).toBe('2026-11-01');
    expect(r.hasta).toBe('2026-11-05');
    expect(r.sucursales.map((s) => s.nombre)).toEqual(['Norte', 'Principal', 'Sin sucursal']);

    const principal = r.sucursales.find((s) => s.nombre === 'Principal')!;
    expect(principal).toEqual({
      id_sucursal: 1,
      nombre: 'Principal',
      turnos: 2,
      turnos_abiertos: 1,
      efectivo_inicial: 70,
      ventas_total: 255, // 140 + 60 + 30 + 25 (crédito incluido, es venta)
      por_metodo: [
        { metodo: 'EFECTIVO', monto: 170 },
        { metodo: 'Yape', monto: 60 },
        { metodo: 'Crédito', monto: 25 },
      ],
      efectivo_esperado: 240, // 190 + 50
      efectivo_contado: 190, // el turno abierto no tiene conteo
      diferencia: 0, // solo el turno cerrado: 190 - 190
    });

    const norte = r.sucursales.find((s) => s.nombre === 'Norte')!;
    expect(norte).toMatchObject({
      id_sucursal: 2,
      turnos: 1,
      turnos_abiertos: 0,
      efectivo_inicial: 100,
      ventas_total: 80,
      por_metodo: [{ metodo: 'Yape', monto: 80 }],
      efectivo_esperado: 100,
      efectivo_contado: 95,
      diferencia: -5,
    });
  });

  it('«Sin sucursal»: si ningún turno guardó su monto inicial, el efectivo inicial es null (sin dato), no 0', async () => {
    const { servicio } = armar(TURNOS);
    const r = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    const sin = r.sucursales.find((s) => s.id_sucursal === null)!;
    expect(sin).toMatchObject({
      nombre: 'Sin sucursal',
      turnos: 1,
      efectivo_inicial: null,
      ventas_total: 40,
      efectivo_esperado: 40,
      efectivo_contado: 40,
      diferencia: 0,
    });
  });

  it('el total suma todos los grupos, incluido por_metodo', async () => {
    const { servicio } = armar(TURNOS);
    const { total, sucursales } = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(total).toEqual({
      id_sucursal: null,
      nombre: 'Total',
      turnos: 4,
      turnos_abiertos: 1,
      efectivo_inicial: 170,
      ventas_total: 375,
      por_metodo: [
        { metodo: 'EFECTIVO', monto: 210 },
        { metodo: 'Yape', monto: 140 },
        { metodo: 'Crédito', monto: 25 },
      ],
      efectivo_esperado: 380,
      efectivo_contado: 325,
      diferencia: -5,
    });
    expect(total.turnos).toBe(sucursales.reduce((a, s) => a + s.turnos, 0));
  });

  it('un rango sin turnos devuelve listas vacías y total en cero', async () => {
    const { servicio } = armar([]);
    const r = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(r.sucursales).toEqual([]);
    expect(r.total).toMatchObject({ turnos: 0, ventas_total: 0, por_metodo: [], efectivo_esperado: 0, diferencia: 0 });
  });

  it('si el esperado de un turno falla, el turno cuenta pero no suma ventas ni esperado', async () => {
    const { servicio, arqueos } = armar([turno({ id_apertura: 10 })]);
    arqueos.filasEsperado.mockRejectedValue(new Error('tabla inexistente'));
    const r = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(r.total).toMatchObject({ turnos: 1, ventas_total: 0, efectivo_esperado: 0, efectivo_contado: 190, diferencia: 0 });
  });

  it('suma sin errores de coma flotante', async () => {
    const filas = [turno({ id_apertura: 10 }), turno({ id_apertura: 11 })];
    const { servicio, arqueos } = armar(filas);
    arqueos.filasEsperado.mockResolvedValue([venta(1, 'EFECTIVO', 'efectivo', 0.1), venta(2, 'Yape', 'yape', 0.2)]);
    const r = await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(r.total.ventas_total).toBe(0.6);
  });
});

describe('CajaTurnosBussnies.resumenSucursales · fechas', () => {
  it('sin fechas usa hoy (Lima) en ambos extremos', async () => {
    const { servicio, sesiones } = armar([]);
    const hoy = hoyLima();
    const r = await servicio.resumenSucursales(admin, {});
    expect(r).toMatchObject({ desde: hoy, hasta: hoy });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ desde: hoy, hasta: hoy }));
  });

  it('solo hasta: el rango es ese día', async () => {
    const { servicio } = armar([]);
    const r = await servicio.resumenSucursales(admin, { hasta: '2026-11-03' });
    expect(r).toMatchObject({ desde: '2026-11-03', hasta: '2026-11-03' });
  });

  it.each([
    ['formato', { desde: '2026/11/01', hasta: '2026-11-05' }],
    ['día inexistente', { desde: '2026-13-01', hasta: '2026-11-05' }],
    ['desde posterior a hasta', { desde: '2026-11-05', hasta: '2026-11-01' }],
    ['más de 366 días', { desde: '2025-01-01', hasta: '2026-11-05' }],
  ])('fecha inválida (%s) → 400 FECHA_INVALIDA', async (_n, consulta) => {
    const { servicio, sesiones } = armar([]);
    expect(await falla(servicio.resumenSucursales(admin, consulta))).toEqual({ estado: 400, codigo: 'FECHA_INVALIDA' });
    expect(sesiones.listarTurnos).not.toHaveBeenCalled();
  });
});

describe('CajaTurnosBussnies.resumenSucursales · permisos', () => {
  it('admin ve todas las sedes: sin restricción de usuario', async () => {
    const { servicio, sesiones } = armar(TURNOS);
    await servicio.resumenSucursales(admin, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idUsuario: undefined, idSucursal: undefined }));
  });

  it('no admin: la consulta queda limitada a sus propios turnos (su sede)', async () => {
    const { servicio, sesiones } = armar([TURNOS[0]]);
    const r = await servicio.resumenSucursales(cajero, { desde: '2026-11-01', hasta: '2026-11-05' });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idUsuario: 7 }));
    expect(r.sucursales).toHaveLength(1);
    expect(r.sucursales[0].nombre).toBe('Principal');
  });

  it('no admin sin id en el token → 403', async () => {
    const { servicio } = armar([]);
    expect(await falla(servicio.resumenSucursales({ ...cajero, id_usuario: 0 }, {}))).toMatchObject({ estado: 403 });
  });
});

describe('CajaTurnosBussnies.resumenSucursalesPdf', () => {
  let generar: jest.SpyInstance;

  beforeEach(() => {
    // Sin red: el logo es decorativo y aquí no se descarga.
    jest.spyOn(logoEmisor, 'obtenerLogoEmisor').mockResolvedValue(null);
    generar = jest.spyOn(pdfResumen, 'generarResumenCajaPdf');
  });
  afterEach(() => jest.restoreAllMocks());

  const rango = { desde: '2026-11-01', hasta: '2026-11-05' };

  it('devuelve un PDF y el nombre resumen-caja-<desde>_<hasta>.pdf con los mismos datos del resumen', async () => {
    const { servicio } = armar(TURNOS);
    const resumen = await servicio.resumenSucursales(admin, rango);
    const { buffer, nombreArchivo } = await servicio.resumenSucursalesPdf(admin, rango);

    expect(nombreArchivo).toBe('resumen-caja-2026-11-01_2026-11-05.pdf');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);

    const datos = generar.mock.calls[0][0] as pdfResumen.DatosResumenCajaPdf;
    expect(datos.desde).toBe('2026-11-01');
    expect(datos.hasta).toBe('2026-11-05');
    expect(datos.sucursal_filtrada).toBeNull();
    expect(datos.sucursales.map((s) => s.nombre)).toEqual(['Norte', 'Principal', 'Sin sucursal']);
    expect(datos.total).toMatchObject({ turnos: 4, ventas_total: resumen.total.ventas_total, efectivo_esperado: 380 });
    expect(datos.sucursales.find((s) => s.nombre === 'Principal')).toMatchObject({
      efectivo_inicial: 70,
      ventas_total: 255,
      efectivo_esperado: 240,
      efectivo_contado: 190,
      diferencia: 0,
    });
  });

  it('no recalcula: usa el esperado del arqueo una vez por turno (como el resumen)', async () => {
    const { servicio, arqueos } = armar(TURNOS);
    await servicio.resumenSucursalesPdf(admin, rango);
    expect(arqueos.filasEsperado).toHaveBeenCalledTimes(4);
  });

  it('sin turnos cerrados, contado y diferencia van como «sin dato» (null), no como 0', async () => {
    const abierto = turno({ id_apertura: 11, cerrada: false, cerrada_en: null, monto_conteo: null });
    const { servicio } = armar([abierto]);
    await servicio.resumenSucursalesPdf(admin, rango);
    const datos = generar.mock.calls[0][0] as pdfResumen.DatosResumenCajaPdf;
    expect(datos.sucursales[0]).toMatchObject({ turnos: 1, turnos_abiertos: 1, efectivo_contado: null, diferencia: null });
    expect(datos.total).toMatchObject({ efectivo_contado: null, diferencia: null });
  });

  it('rango sin turnos: PDF válido, sin sucursales ni banda de TOTAL', async () => {
    const { servicio } = armar([]);
    const { buffer } = await servicio.resumenSucursalesPdf(admin, rango);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const datos = generar.mock.calls[0][0] as pdfResumen.DatosResumenCajaPdf;
    expect(datos.sucursales).toEqual([]);
    expect(datos.total).toBeNull();
  });

  it('sin fechas usa hoy (Lima) en el nombre del archivo', async () => {
    const { servicio } = armar([]);
    const hoy = hoyLima();
    expect((await servicio.resumenSucursalesPdf(admin, {})).nombreArchivo).toBe(`resumen-caja-${hoy}_${hoy}.pdf`);
  });

  it('id_sucursal filtra a una sucursal y el total del PDF es el de ella', async () => {
    const { servicio, sesiones } = armar([TURNOS[2]]);
    await servicio.resumenSucursalesPdf(admin, { ...rango, id_sucursal: 2 });
    expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idSucursal: 2 }));
    const datos = generar.mock.calls[0][0] as pdfResumen.DatosResumenCajaPdf;
    expect(datos.sucursal_filtrada).toBe('Norte');
    expect(datos.sucursales).toHaveLength(1);
    expect(datos.total).toMatchObject({ turnos: 1, efectivo_inicial: 100, ventas_total: 80, efectivo_contado: 95, diferencia: -5 });
  });

  it('id_sucursal sin turnos en el rango: nombra la sucursal por su número', async () => {
    const { servicio } = armar([]);
    await servicio.resumenSucursalesPdf(admin, { ...rango, id_sucursal: 9 });
    expect((generar.mock.calls[0][0] as pdfResumen.DatosResumenCajaPdf).sucursal_filtrada).toBe('Sucursal 9');
  });

  it('el logo viene de la configuración «Logo para documentos» y su fallo no impide el PDF', async () => {
    const { sesiones, arqueos } = armar([TURNOS[0]]);
    const config = { obtenerVarias: jest.fn().mockResolvedValue({ emisor_logo_url: ' https://x.pe/logo.png ' }) };
    const servicio = new CajaTurnosBussnies(sesiones as any, arqueos as any, config as any);
    await servicio.resumenSucursalesPdf(admin, rango);
    expect(config.obtenerVarias).toHaveBeenCalledWith(['emisor_logo_url']);
    expect(logoEmisor.obtenerLogoEmisor).toHaveBeenCalledWith('https://x.pe/logo.png');

    config.obtenerVarias.mockRejectedValue(new Error('sin BD'));
    const { buffer } = await servicio.resumenSucursalesPdf(admin, rango);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('un logo que falla no impide generar el PDF', async () => {
    jest.spyOn(logoEmisor, 'obtenerLogoEmisor').mockRejectedValue(new Error('red caída'));
    const { servicio } = armar([TURNOS[0]]);
    const { buffer } = await servicio.resumenSucursalesPdf(admin, rango);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it.each([
    ['formato', { desde: '2026/11/01', hasta: '2026-11-05' }],
    ['más de 366 días', { desde: '2025-01-01', hasta: '2026-11-05' }],
  ])('fecha inválida (%s) → 400 FECHA_INVALIDA', async (_n, consulta) => {
    const { servicio } = armar([]);
    expect(await falla(servicio.resumenSucursalesPdf(admin, consulta))).toEqual({ estado: 400, codigo: 'FECHA_INVALIDA' });
    expect(generar).not.toHaveBeenCalled();
  });

  describe('permisos', () => {
    it('no admin: solo sus turnos', async () => {
      const { servicio, sesiones } = armar([TURNOS[0]]);
      await servicio.resumenSucursalesPdf(cajero, rango);
      expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idUsuario: 7 }));
    });

    it('no admin con una sucursal propia: permitido', async () => {
      const { servicio } = armar([TURNOS[0]], [1]);
      const { buffer } = await servicio.resumenSucursalesPdf(cajero, { ...rango, id_sucursal: 1 });
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('no admin con una sucursal fuera de su sede → 403 CAJA_TURNO_AJENO', async () => {
      const { servicio, sesiones } = armar([], [1]);
      expect(await falla(servicio.resumenSucursalesPdf(cajero, { ...rango, id_sucursal: 2 }))).toEqual({
        estado: 403,
        codigo: 'CAJA_TURNO_AJENO',
      });
      expect(sesiones.listarTurnos).not.toHaveBeenCalled();
      expect(generar).not.toHaveBeenCalled();
    });

    it('admin con cualquier sucursal: sin restricción de usuario', async () => {
      const { servicio, sesiones } = armar([TURNOS[2]]);
      await servicio.resumenSucursalesPdf(admin, { ...rango, id_sucursal: 2 });
      expect(sesiones.listarTurnos).toHaveBeenCalledWith(expect.objectContaining({ idUsuario: undefined, idSucursal: 2 }));
    });

    it('no admin sin id en el token → 403', async () => {
      const { servicio } = armar([]);
      expect(await falla(servicio.resumenSucursalesPdf({ ...cajero, id_usuario: 0 }, {}))).toMatchObject({ estado: 403 });
    });
  });
});
