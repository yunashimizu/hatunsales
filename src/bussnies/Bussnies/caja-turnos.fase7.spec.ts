import { CajaTurnosBussnies } from './caja-turnos.bussnies';
import type { FilaTurno } from '../../repository/Repository/caja-sesion.repository';
import { Dinero } from '../../caja/dominio/dinero';

/** Fase 7.3 (arqueo ciego en el listado de turnos y el tablero por local), 7.4 (marca) y 7.6 (ventas sin turno). */
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
    abierta_en: '2026-11-25T13:00:00.000Z',
    cerrada_en: '2026-11-25T22:00:00.000Z',
    monto_inicial: Dinero.deSoles(50),
    monto_conteo: Dinero.deSoles(190),
    cerrada: true,
    ...extra,
  };
}
const efectivo = (total: number) => ({ fuente: 'venta', id_metodo: 1, nombre: 'EFECTIVO', tipo: 'efectivo', total: Dinero.deSoles(total), cantidad: 1, vuelto: Dinero.CERO });

// Turno 10 cerrado (esperado 190) y turno 11 abierto (esperado 20 + 30 = 50).
const TURNOS = [
  turno({ id_apertura: 10, cierre_automatico: true, monto_conteo: null }),
  turno({ id_apertura: 11, cerrada: false, cerrada_en: null, monto_inicial: Dinero.deSoles(20), monto_conteo: null }),
];
const FUENTES: Record<number, unknown[]> = { 10: [efectivo(140)], 11: [efectivo(30)] };

function armar(ciego: boolean | undefined) {
  const sesiones = {
    listarTurnos: jest.fn().mockResolvedValue({ filas: TURNOS, total: TURNOS.length }),
    sucursalesDeUsuario: jest.fn().mockResolvedValue([1]),
    sucursalDeCaja: jest.fn().mockResolvedValue(1),
    ventasSinTurno: jest.fn().mockResolvedValue([
      { id_sucursal: 1, sucursal_nombre: 'Principal', cantidad: 2, monto: Dinero.deSoles(150.5) },
      { id_sucursal: null, sucursal_nombre: null, cantidad: 1, monto: Dinero.deSoles(10) },
    ]),
  };
  const arqueos = { filasEsperado: jest.fn(async (id: number) => FUENTES[id] ?? []) };
  const control = ciego === undefined ? undefined : { arqueoCiego: jest.fn().mockResolvedValue(ciego) };
  return { servicio: new CajaTurnosBussnies(sesiones as never, arqueos as never, undefined, control as never), sesiones };
}

describe('CajaTurnosBussnies.aperturas · Fase 7', () => {
  it('sin arqueo ciego: el esperado del turno abierto se ve; la marca del cierre automático viene en el cerrado', async () => {
    const r = await armar(false).servicio.aperturas(cajero as never, {});
    const [cerrado, abierto] = r.items;
    expect(cerrado).toMatchObject({ efectivo_esperado: 190, efectivo_contado: null, diferencia: null, cierre_automatico: true });
    expect(abierto).toMatchObject({ efectivo_esperado: 50 });
    expect(abierto).not.toHaveProperty('esperado_oculto');
    expect(abierto).not.toHaveProperty('cierre_automatico');
  });

  it('con arqueo ciego, el cajero no ve el esperado de su turno ABIERTO (el del cerrado sí); el admin ve todo', async () => {
    const r = await armar(true).servicio.aperturas(cajero as never, {});
    expect(r.items[1]).toMatchObject({ efectivo_esperado: null, diferencia: null, esperado_oculto: true });
    expect(r.items[0]).toMatchObject({ efectivo_esperado: 190 });
    expect(r.items[0]).not.toHaveProperty('esperado_oculto');

    const a = await armar(true).servicio.aperturas(admin as never, {});
    expect(a.items[1]).toMatchObject({ efectivo_esperado: 50 });
  });
});

describe('CajaTurnosBussnies.resumenSucursales · arqueo ciego (7.3)', () => {
  const rango = { desde: '2026-11-25', hasta: '2026-11-25' };

  it('con un turno abierto propio, el cajero recibe esperado, ventas y medios ocultos en su local y en el total', async () => {
    const r = await armar(true).servicio.resumenSucursales(cajero as never, rango);
    for (const g of [r.sucursales[0], r.total]) {
      expect(g).toMatchObject({ efectivo_esperado: null, ventas_total: null, por_metodo: [], esperado_oculto: true, turnos_abiertos: 1 });
    }
  });

  it('apagado, o el admin: los montos de siempre y sin la marca', async () => {
    for (const [ciego, quien] of [[false, cajero], [true, admin]] as const) {
      const r = await armar(ciego).servicio.resumenSucursales(quien as never, rango);
      expect(r.total).toMatchObject({ efectivo_esperado: 240, ventas_total: 170 });
      expect(r.total).not.toHaveProperty('esperado_oculto');
    }
  });
});

describe('CajaTurnosBussnies.ventasSinTurno (7.6)', () => {
  it('cuenta por local; el monto solo para el admin; por defecto el día de hoy', async () => {
    const { servicio, sesiones } = armar(undefined);
    const a = await servicio.ventasSinTurno(admin as never, '2026-11-25');
    expect(a).toEqual({
      fecha: '2026-11-25',
      cantidad: 3,
      monto: 160.5,
      por_local: [
        { id_sucursal: 1, nombre: 'Principal', cantidad: 2, monto: 150.5 },
        { id_sucursal: null, nombre: 'Sin local', cantidad: 1, monto: 10 },
      ],
    });
    const c = await servicio.ventasSinTurno(cajero as never);
    expect(c.monto).toBeNull();
    expect(c.por_local.every((l) => l.monto === null)).toBe(true);
    expect(sesiones.ventasSinTurno).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('una fecha mal escrita es 400 FECHA_INVALIDA', async () => {
    const error = await armar(undefined).servicio.ventasSinTurno(admin as never, '2026-13-40').catch((e: unknown) => e);
    expect((error as { getStatus(): number }).getStatus()).toBe(400);
  });
});
