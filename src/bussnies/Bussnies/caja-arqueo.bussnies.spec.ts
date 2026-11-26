import { HttpException, Logger } from '@nestjs/common';
import { Dinero } from '../../caja/dominio/dinero';
import { CajaArqueoBussnies } from './caja-arqueo.bussnies';

/**
 * Fase 7.3 (arqueo ciego) y 7.5 (gasto con categoría) sobre CajaArqueoBussnies, con dobles.
 * Turno 10 de Rosa (rol caja): inicial 50, ventas en efectivo 120, Yape 30 → esperado 170.
 */
const ROSA = { id_usuario: 7, nombre: 'Rosa', email: 'r@x.pe', rol: 'caja', permisos: [] };
const ADMIN = { id_usuario: 1, nombre: 'Moisés', email: 'm@x.pe', rol: 'admin', permisos: [] };

function armar(opciones: { ciego?: boolean; fase20?: boolean } = {}) {
  const turno = {
    id_apertura: 10,
    id_caja: 1,
    caja_nombre: 'Caja 1',
    sucursal_nombre: 'Principal',
    id_usuario: 7,
    usuario_nombre: 'Rosa',
    fecha_apertura: new Date('2026-11-25T13:00:00Z'),
    monto_inicial: Dinero.deSoles(50),
    abierta: true,
    id_cierre: null,
    fecha_cierre: null,
  };
  const repo = {
    turno: jest.fn(async () => turno),
    filasEsperado: jest.fn(async () => [
      { fuente: 'venta', id_metodo: 1, nombre: 'EFECTIVO', tipo: '', total: Dinero.deSoles(120), cantidad: 3, vuelto: Dinero.deSoles(5) },
      { fuente: 'venta', id_metodo: 5, nombre: 'Yape', tipo: 'billetera', total: Dinero.deSoles(30), cantidad: 1, vuelto: Dinero.CERO },
    ]),
    listarPorTurno: jest.fn(async () => []),
    transaccion: jest.fn(async (trabajo: (m: unknown) => Promise<unknown>) => trabajo({})),
    registrarMovimiento: jest.fn(async () => 900),
  };
  const sesiones = { sesionUsuario: jest.fn(async () => ({ id_apertura: 10 })), bloquearApertura: jest.fn(async () => true) };
  const credito = { metodosConTipo: jest.fn(async () => [{ id_metodo: 5, nombre: 'Yape', tipo: 'billetera' }]) };
  const config = { obtenerNumero: jest.fn(async () => 0) };
  const esquema = {
    exigir: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({ tieneColumna: () => opciones.fase20 ?? true })),
  };
  const control = opciones.ciego === undefined ? undefined : { arqueoCiego: jest.fn(async () => opciones.ciego) };
  const servicio = new CajaArqueoBussnies(repo as never, sesiones as never, credito as never, config as never, esquema as never, control as never);
  return { servicio, repo };
}

async function errorDe(p: Promise<unknown>): Promise<{ estado: number; codigo?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const http = e as HttpException;
    const cuerpo = http.getResponse() as { codigo?: string; message: string };
    return { estado: http.getStatus(), codigo: cuerpo.codigo, message: cuerpo.message };
  }
  throw new Error('Se esperaba un error HTTP');
}

beforeAll(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));

describe('CajaArqueoBussnies.esperado · arqueo ciego (7.3)', () => {
  it('sin el servicio o con la clave apagada: los montos de siempre y las marcas en false', async () => {
    for (const ciego of [undefined, false]) {
      const r = await armar({ ciego }).servicio.esperado(ROSA as never);
      expect(r.efectivo.esperado).toBe(170);
      expect(r.efectivo.ventas).toBe(120);
      expect(r.total_cobrado).toBe(150);
      expect(r).toMatchObject({ arqueo_ciego: !!ciego, esperado_oculto: false });
    }
  });

  it('encendida y rol caja: esperado, ventas, abonos, vueltos y total cobrado en null; lo que el cajero ya sabe, no', async () => {
    const r = await armar({ ciego: true }).servicio.esperado(ROSA as never);
    expect(r).toMatchObject({ arqueo_ciego: true, esperado_oculto: true, total_cobrado: null });
    expect(r.efectivo).toMatchObject({ esperado: null, ventas: null, abonos: null, vueltos_entregados: null, monto_inicial: 50, ingresos: 0, egresos: 0, operaciones_ventas: 3 });
    expect(r.efectivo.metodos.every((m) => m.esperado === null && m.ventas === null)).toBe(true);
    expect(r.otros_medios).toHaveLength(1);
    expect(r.otros_medios[0]).toMatchObject({ nombre: 'Yape', esperado: null, ventas: null, operaciones: 1 });
    expect(JSON.stringify([r.efectivo, r.otros_medios, r.total_cobrado])).not.toContain('170');
  });

  it('encendida y admin: lo ve todo', async () => {
    const r = await armar({ ciego: true }).servicio.esperado(ADMIN as never);
    expect(r).toMatchObject({ arqueo_ciego: true, esperado_oculto: false });
    expect(r.efectivo.esperado).toBe(170);
  });
});

describe('CajaArqueoBussnies.registrarMovimiento · gasto con categoría (7.5) y arqueo ciego', () => {
  it('egreso con categoría y número: se guardan y vuelven en la respuesta', async () => {
    const { servicio, repo } = armar();
    const r = await servicio.registrarMovimiento(ROSA as never, { tipo: 'egreso', monto: 12.5, descripcion: 'Taxi al banco', categoria: 'transporte', nro_comprobante: ' B001-77 ' });
    expect(repo.registrarMovimiento).toHaveBeenCalledWith({}, expect.objectContaining({ categoria: 'transporte', nro_comprobante: 'B001-77', tipo: 'egreso' }));
    expect(r).toMatchObject({ categoria: 'transporte', categoria_etiqueta: 'Transporte', nro_comprobante: 'B001-77', id_venta: null });
  });

  it('sin sql/fase20 el gasto se registra igual y la respuesta dice que no se guardó la categoría', async () => {
    const { servicio } = armar({ fase20: false });
    const r = await servicio.registrarMovimiento(ROSA as never, { tipo: 'egreso', monto: 5, descripcion: 'Agua', categoria: 'servicios' });
    expect(r).toMatchObject({ categoria: null, nro_comprobante: null, monto: 5 });
  });

  it('el front de hoy (sin categoría) no cambia nada; un ingreso con categoría es 400', async () => {
    const { servicio, repo } = armar();
    await servicio.registrarMovimiento(ROSA as never, { tipo: 'ingreso', monto: 20, descripcion: 'Sencillo' });
    expect(repo.registrarMovimiento).toHaveBeenCalledWith({}, expect.objectContaining({ categoria: null, nro_comprobante: null }));
    const e = await errorDe(servicio.registrarMovimiento(ROSA as never, { tipo: 'ingreso', monto: 20, descripcion: 'Sencillo', categoria: 'otro' }));
    expect([e.estado, e.codigo]).toEqual([400, 'CAJA_MOVIMIENTO_INVALIDO']);
  });

  it('egreso mayor que el efectivo: el mensaje cita el esperado salvo con el arqueo ciego (rol caja)', async () => {
    const visible = await errorDe(armar({ ciego: false }).servicio.registrarMovimiento(ROSA as never, { tipo: 'egreso', monto: 500, descripcion: 'Compra' }));
    expect(visible.codigo).toBe('CAJA_EGRESO_EXCEDE_EFECTIVO');
    expect(visible.message).toContain('S/ 170.00');
    const ciego = await errorDe(armar({ ciego: true }).servicio.registrarMovimiento(ROSA as never, { tipo: 'egreso', monto: 500, descripcion: 'Compra' }));
    expect(ciego.codigo).toBe('CAJA_EGRESO_EXCEDE_EFECTIVO');
    expect(ciego.message).not.toContain('170');
  });
});
