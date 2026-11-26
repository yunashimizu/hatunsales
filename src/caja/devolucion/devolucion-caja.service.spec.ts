import { Logger } from '@nestjs/common';
import { Dinero } from '../dominio/dinero';
import { CalculadoraEsperado, FilaFuenteCaja } from '../dominio/esperado-caja';
import { ErrorCaja } from '../dominio/errores-caja';
import { DevolucionCajaService } from './devolucion-caja.service';
import type { EfectivoDeVenta, TurnoDeVenta } from './devolucion-caja.repository';
import { calcularReembolsable, descripcionDevolucion } from './reembolso';

/**
 * Fase 7.1 (corregida por R8). Una «base» en memoria que calcula el esperado de cada turno con la MISMA regla
 * que sql-esperado.ts: las ventas de mostrador no anuladas del turno suman su efectivo, las anuladas no;
 * los ingresos suman y los egresos restan. Así se comprueba que el esperado nunca descuenta dos veces ni deja
 * de descontar en los tres escenarios del plan.
 */

interface VentaFalsa {
  id: number;
  estado: 'activa' | 'anulada';
  efectivo: number;
  abonosEfectivo?: number;
  id_apertura: number | null;
}
interface TurnoFalso {
  id_apertura: number;
  id_caja: number;
  id_usuario: number;
  monto_inicial: number;
  abierta: boolean;
}
interface MovimientoFalso {
  id_apertura: number;
  tipo: 'ingreso' | 'egreso';
  monto: number;
  id_venta: number | null;
  categoria: string | null;
  descripcion: string;
}

class BaseFalsa {
  ventas = new Map<number, VentaFalsa>();
  turnos = new Map<number, TurnoFalso>();
  movimientos: MovimientoFalso[] = [];

  filasEsperado(idApertura: number): FilaFuenteCaja[] {
    const filas: FilaFuenteCaja[] = [];
    for (const v of this.ventas.values()) {
      if (v.id_apertura !== idApertura) continue;
      if (v.estado === 'anulada') {
        filas.push({ fuente: 'venta_anulada', id_metodo: null, nombre: null, tipo: null, total: Dinero.deSoles(v.efectivo), cantidad: 1 });
      } else {
        filas.push({ fuente: 'venta', id_metodo: 1, nombre: 'EFECTIVO', tipo: '', total: Dinero.deSoles(v.efectivo), cantidad: 1, vuelto: Dinero.CERO });
      }
    }
    for (const m of this.movimientos.filter((x) => x.id_apertura === idApertura)) {
      filas.push({ fuente: m.tipo, id_metodo: null, nombre: null, tipo: null, total: Dinero.deSoles(m.monto), cantidad: 1 });
    }
    return filas;
  }

  esperado(idApertura: number): number {
    const t = this.turnos.get(idApertura)!;
    return CalculadoraEsperado.calcular(Dinero.deSoles(t.monto_inicial), this.filasEsperado(idApertura)).efectivo.esperado.aNumero();
  }

  efectivoDeVenta(idVenta: number, fase20: boolean): EfectivoDeVenta | null {
    const v = this.ventas.get(idVenta);
    if (!v) return null;
    const t = v.id_apertura != null ? this.turnos.get(v.id_apertura) : undefined;
    const turno: TurnoDeVenta | null = t
      ? { id_apertura: t.id_apertura, id_usuario: t.id_usuario, usuario_nombre: `Usuario ${t.id_usuario}`, caja_nombre: `Caja ${t.id_caja}`, abierto: t.abierta }
      : null;
    const devuelto = this.movimientos.filter((m) => m.id_venta === idVenta && m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
    return {
      id_venta: v.id,
      estado: v.estado,
      efectivo_venta: Dinero.deSoles(v.efectivo),
      abonos_efectivo: Dinero.deSoles(v.abonosEfectivo ?? 0),
      abonos_total: Dinero.deSoles(v.abonosEfectivo ?? 0),
      ya_reembolsado: fase20 ? Dinero.desdeNumeroRedondeado(devuelto) : null,
      turno,
    };
  }
}

const ADMIN = { id_usuario: 1, rol: 'admin' };

function armar(opciones: { fase20?: boolean; ciego?: boolean } = {}) {
  const fase20 = opciones.fase20 ?? true;
  const base = new BaseFalsa();
  const repo = {
    efectivoDeVenta: jest.fn(async (id: number) => base.efectivoDeVenta(id, fase20)),
    turnoDeVenta: jest.fn(async (id: number) => base.efectivoDeVenta(id, fase20)?.turno ?? null),
    abonosDeVenta: jest.fn(async () => Dinero.CERO),
    bloquearReembolso: jest.fn(async () => undefined),
  };
  const turnoArqueo = (id: number) => {
    const t = base.turnos.get(id);
    return t ? { id_apertura: t.id_apertura, id_caja: t.id_caja, id_usuario: t.id_usuario, monto_inicial: Dinero.deSoles(t.monto_inicial), abierta: t.abierta } : null;
  };
  const arqueos = {
    turno: jest.fn(async (id: number) => turnoArqueo(id)),
    filasEsperado: jest.fn(async (id: number) => base.filasEsperado(id)),
    transaccion: jest.fn(async (trabajo: (m: unknown) => Promise<unknown>) => trabajo({ tx: true })),
    registrarMovimiento: jest.fn(async (_m: unknown, d: { id_apertura: number; tipo: 'egreso'; monto: Dinero; id_venta?: number | null; categoria?: string | null; descripcion: string }) => {
      base.movimientos.push({ id_apertura: d.id_apertura, tipo: d.tipo, monto: d.monto.aNumero(), id_venta: d.id_venta ?? null, categoria: d.categoria ?? null, descripcion: d.descripcion });
      return 500 + base.movimientos.length;
    }),
  };
  const sesiones = {
    sesionUsuario: jest.fn(async (idUsuario: number) => {
      const t = [...base.turnos.values()].find((x) => x.id_usuario === idUsuario && x.abierta);
      return t ? { id_apertura: t.id_apertura, caja_nombre: `Caja ${t.id_caja}` } : null;
    }),
    bloquearApertura: jest.fn(async () => true),
  };
  const esquema = {
    tiene: jest.fn(async (c: string) => (c === 'movimientoVenta' ? fase20 : true)),
    snapshot: jest.fn(async () => ({ tieneColumna: () => fase20 })),
  };
  const control = { arqueoCiego: jest.fn(async () => opciones.ciego ?? false), modoAnulacionCredito: jest.fn(async () => 'bloquear') };
  const bitacora = { registrarCon: jest.fn(async (fabrica: () => unknown) => fabrica()) };
  const servicio = new DevolucionCajaService(repo as never, arqueos as never, sesiones as never, esquema as never, control as never, bitacora as never);
  return { servicio, base, repo, arqueos, sesiones, bitacora };
}

async function errorDe(promesa: Promise<unknown>): Promise<ErrorCaja> {
  try {
    await promesa;
  } catch (e) {
    return e as ErrorCaja;
  }
  throw new Error('Se esperaba un error');
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('calcularReembolsable (utilidad pura)', () => {
  const datos = (p: Partial<EfectivoDeVenta>): EfectivoDeVenta => ({
    id_venta: 9,
    estado: 'activa',
    efectivo_venta: Dinero.deSoles(100),
    abonos_efectivo: Dinero.CERO,
    abonos_total: Dinero.CERO,
    ya_reembolsado: Dinero.CERO,
    turno: { id_apertura: 1, id_usuario: 7, usuario_nombre: null, caja_nombre: 'Caja 1', abierto: false },
    ...p,
  });

  it('turno cerrado: anular admite devolver todo lo cobrado en efectivo; parcial, igual', () => {
    expect(calcularReembolsable(datos({}), 'anulacion').maximo.aNumero()).toBe(100);
    expect(calcularReembolsable(datos({}), 'parcial').maximo.aNumero()).toBe(100);
  });

  it('turno abierto: anular no admite egreso por lo cobrado en la venta (la anulación ya lo descuenta)', () => {
    const abierto = datos({ turno: { id_apertura: 1, id_usuario: 7, usuario_nombre: null, caja_nombre: 'Caja 1', abierto: true } });
    const r = calcularReembolsable(abierto, 'anulacion');
    expect(r.maximo.aNumero()).toBe(0);
    expect(r.venta_en_turno_abierto).toBe(true);
    expect(r.descontado_por_anulacion.aNumero()).toBe(100);
    // La devolución parcial sí: la venta sigue activa y su cobro sigue contando.
    expect(calcularReembolsable(abierto, 'parcial').maximo.aNumero()).toBe(100);
  });

  it('los abonos en efectivo siempre admiten egreso (el esperado no los quita al anular) y se resta lo ya devuelto', () => {
    const abierto = datos({
      efectivo_venta: Dinero.CERO,
      abonos_efectivo: Dinero.deSoles(40),
      ya_reembolsado: Dinero.deSoles(15),
      turno: { id_apertura: 1, id_usuario: 7, usuario_nombre: null, caja_nombre: 'Caja 1', abierto: true },
    });
    expect(calcularReembolsable(abierto, 'anulacion').maximo.aNumero()).toBe(25);
    expect(calcularReembolsable(datos({ ya_reembolsado: Dinero.deSoles(130) }), 'parcial').maximo.aNumero()).toBe(0);
  });

  it('venta sin turno (caja blanda): como un turno cerrado', () => {
    expect(calcularReembolsable(datos({ turno: null }), 'anulacion').maximo.aNumero()).toBe(100);
  });

  it('la descripción es legible y no pasa de 200 caracteres', () => {
    expect(descripcionDevolucion(12)).toBe('Devolución de la venta 12');
    expect(descripcionDevolucion(12, 'nota FC01-00000002')).toBe('Devolución de la venta 12 · nota FC01-00000002');
    expect(descripcionDevolucion(12, 'x'.repeat(300))).toHaveLength(200);
  });
});

describe('DevolucionCajaService · los tres escenarios de 7.1', () => {
  it('MISMO turno: anular no genera egreso; el esperado baja solo por la anulación (una vez)', async () => {
    const { servicio, base, arqueos } = armar();
    base.turnos.set(1, { id_apertura: 1, id_caja: 1, id_usuario: 1, monto_inicial: 50, abierta: true });
    base.ventas.set(9, { id: 9, estado: 'activa', efectivo: 100, id_apertura: 1 });
    expect(base.esperado(1)).toBe(150);

    // El front, con la lectura, no manda reembolso: no hay nada que validar ni registrar.
    const lectura = await servicio.consultar(9, ADMIN);
    expect(lectura).toMatchObject({ venta_en_turno_abierto: true, maximo_anulacion: 0, maximo_devolucion_parcial: 100, disponible: true });
    expect(lectura.mensaje).toContain('No registre un egreso');
    expect(await servicio.prevalidar(9, undefined, 'anulacion', ADMIN)).toBeNull();

    // Si de todos modos lo manda, se rechaza ANTES de anular (sería descontar dos veces).
    const error = await errorDe(servicio.prevalidar(9, 100, 'anulacion', ADMIN));
    expect(error.codigo).toBe('REEMBOLSO_EXCEDE');
    expect(error.message).toContain('ya baja S/ 100.00 (no lleva egreso)');

    base.ventas.get(9)!.estado = 'anulada'; // la anulación
    expect(base.esperado(1)).toBe(50);
    expect(base.movimientos).toHaveLength(0);
    expect(arqueos.registrarMovimiento).not.toHaveBeenCalled();
  });

  it('OTRO turno (cerrado): egreso con id_venta en el turno abierto de quien devuelve; su esperado baja por el monto', async () => {
    const { servicio, base, bitacora } = armar();
    base.turnos.set(1, { id_apertura: 1, id_caja: 1, id_usuario: 1, monto_inicial: 0, abierta: false });
    base.turnos.set(2, { id_apertura: 2, id_caja: 1, id_usuario: 1, monto_inicial: 200, abierta: true });
    base.ventas.set(9, { id: 9, estado: 'activa', efectivo: 100, id_apertura: 1 });
    const esperadoNuevoAntes = base.esperado(2);
    expect(esperadoNuevoAntes).toBe(200);

    const lectura = await servicio.consultar(9, ADMIN);
    expect(lectura).toMatchObject({ venta_en_turno_abierto: false, maximo_anulacion: 100, turno_usuario: { id_apertura: 2 }, requiere_abrir_caja: false });

    const plan = await servicio.prevalidar(9, 100, 'anulacion', ADMIN);
    expect(plan).toMatchObject({ id_venta: 9, tipo: 'anulacion', id_apertura: 2, id_usuario: 1 });
    base.ventas.get(9)!.estado = 'anulada'; // la anulación
    const r = await servicio.registrar(plan!, ADMIN, 'anulación');

    expect(r).toMatchObject({ registrado: true, monto: 100, id_apertura: 2, aviso: null });
    expect(base.movimientos).toEqual([
      { id_apertura: 2, tipo: 'egreso', monto: 100, id_venta: 9, categoria: 'devolucion', descripcion: 'Devolución de la venta 9 · anulación' },
    ]);
    expect(base.esperado(2)).toBe(esperadoNuevoAntes - 100);
    expect(bitacora.registrarCon).toHaveBeenCalledTimes(1);
    expect(await bitacora.registrarCon.mock.results[0].value).toMatchObject({ accion: 'caja.devolucion_efectivo', entidad: 'venta', id_entidad: 9 });

    // Segunda devolución de la misma venta: ya no queda nada por devolver.
    expect((await errorDe(servicio.prevalidar(9, 1, 'anulacion', ADMIN))).codigo).toBe('REEMBOLSO_EXCEDE');
  });

  it('devolución PARCIAL: la venta sigue activa; egreso por lo devuelto, también en el mismo turno', async () => {
    const { servicio, base } = armar();
    base.turnos.set(1, { id_apertura: 1, id_caja: 1, id_usuario: 1, monto_inicial: 50, abierta: true });
    base.ventas.set(9, { id: 9, estado: 'activa', efectivo: 100, id_apertura: 1 });

    const plan = await servicio.prevalidar(9, 30, 'parcial', ADMIN, { monto: Dinero.deSoles(30), texto: 'el total de la nota' });
    await servicio.registrar(plan!, ADMIN, 'nota FC01-00000002');

    expect(base.ventas.get(9)!.estado).toBe('activa');
    expect(base.esperado(1)).toBe(150 - 30);
    // Lo que queda por devolver baja: 70 en parcial; si luego se anula en el mismo turno, nada (y avisa por qué).
    expect((await servicio.consultar(9, ADMIN)).maximo_devolucion_parcial).toBe(70);
    // El límite de la nota manda aunque quede efectivo por devolver.
    const tope = await errorDe(servicio.prevalidar(9, 40, 'parcial', ADMIN, { monto: Dinero.deSoles(30), texto: 'el total de la nota' }));
    expect(tope.codigo).toBe('REEMBOLSO_EXCEDE');
    expect(tope.message).toContain('supera el total de la nota (S/ 30.00)');
  });
});

describe('DevolucionCajaService · validaciones antes de tocar nada', () => {
  function conVentaDeOtroTurno(opciones: Parameters<typeof armar>[0] = {}) {
    const a = armar(opciones);
    a.base.turnos.set(1, { id_apertura: 1, id_caja: 1, id_usuario: 7, monto_inicial: 0, abierta: false });
    a.base.ventas.set(9, { id: 9, estado: 'activa', efectivo: 100, id_apertura: 1 });
    return a;
  }

  it('0 o ausente: null (todo como antes); negativo, texto o 3 decimales: 400 REEMBOLSO_INVALIDO', async () => {
    const { servicio } = conVentaDeOtroTurno();
    expect(await servicio.prevalidar(9, 0, 'anulacion', ADMIN)).toBeNull();
    expect(await servicio.prevalidar(9, null, 'anulacion', ADMIN)).toBeNull();
    for (const malo of [-1, 'abc', 10.123]) {
      const e = await errorDe(servicio.prevalidar(9, malo, 'anulacion', ADMIN));
      expect([e.codigo, e.estadoHttp]).toEqual(['REEMBOLSO_INVALIDO', 400]);
    }
  });

  it('sin sql/fase20: 503 REEMBOLSO_NO_DISPONIBLE (no se puede saber lo ya devuelto)', async () => {
    const { servicio } = conVentaDeOtroTurno({ fase20: false });
    const e = await errorDe(servicio.prevalidar(9, 50, 'anulacion', ADMIN));
    expect([e.codigo, e.estadoHttp]).toEqual(['REEMBOLSO_NO_DISPONIBLE', 503]);
    expect(e.message).toContain('sql/fase20_caja_devoluciones.sql');
    // La lectura lo dice sin fallar.
    expect(await servicio.consultar(9, ADMIN)).toMatchObject({ disponible: false, ya_reembolsado: null });
  });

  it('sin caja abierta: 409 CAJA_NO_ABIERTA que pide abrirla', async () => {
    const { servicio } = conVentaDeOtroTurno();
    const e = await errorDe(servicio.prevalidar(9, 50, 'anulacion', { id_usuario: 3, rol: 'admin' }));
    expect([e.codigo, e.estadoHttp]).toEqual(['CAJA_NO_ABIERTA', 409]);
    expect(e.message).toContain('abra su caja');
    expect(await servicio.consultar(9, { id_usuario: 3, rol: 'admin' })).toMatchObject({ requiere_abrir_caja: true, turno_usuario: null });
  });

  it('más que el efectivo de la caja: 409 con el esperado; con el arqueo ciego y rol caja, sin el número', async () => {
    const abierto = { id_apertura: 2, id_caja: 2, id_usuario: 5, monto_inicial: 30, abierta: true };
    const visible = conVentaDeOtroTurno();
    visible.base.turnos.set(2, { ...abierto });
    const e1 = await errorDe(visible.servicio.prevalidar(9, 50, 'anulacion', { id_usuario: 5, rol: 'caja' }));
    expect(e1.codigo).toBe('CAJA_EGRESO_EXCEDE_EFECTIVO');
    expect(e1.message).toContain('(S/ 30.00)');

    const ciego = conVentaDeOtroTurno({ ciego: true });
    ciego.base.turnos.set(2, { ...abierto });
    const e2 = await errorDe(ciego.servicio.prevalidar(9, 50, 'anulacion', { id_usuario: 5, rol: 'caja' }));
    expect(e2.codigo).toBe('CAJA_EGRESO_EXCEDE_EFECTIVO');
    expect(e2.message).not.toContain('30.00');
  });

  it('venta inexistente: 404', async () => {
    const { servicio } = conVentaDeOtroTurno();
    expect((await errorDe(servicio.prevalidar(99, 5, 'anulacion', ADMIN))).estadoHttp).toBe(404);
  });

  it('registrar nunca lanza: si el turno se cerró entre tanto, devuelve el aviso para hacerlo a mano', async () => {
    const { servicio, base } = conVentaDeOtroTurno();
    base.turnos.set(2, { id_apertura: 2, id_caja: 1, id_usuario: 1, monto_inicial: 500, abierta: true });
    const plan = await servicio.prevalidar(9, 100, 'anulacion', ADMIN);
    base.turnos.get(2)!.abierta = false;
    const r = await servicio.registrar(plan!, ADMIN);
    expect(r).toMatchObject({ registrado: false, id_movimiento: null });
    expect(r.aviso).toContain('Regístrela a mano');
    expect(base.movimientos).toHaveLength(0);
  });
});

describe('DevolucionCajaService · 7.2 crédito con abonos', () => {
  function conAbonos(abonado: number, modo: 'bloquear' | 'permitir') {
    const { servicio, repo } = armar();
    repo.abonosDeVenta.mockResolvedValue(Dinero.deSoles(abonado));
    (servicio as unknown as { control: { modoAnulacionCredito: jest.Mock } }).control.modoAnulacionCredito.mockResolvedValue(modo);
    return servicio;
  }

  it('bloquear (por defecto) con abonos → 409; sin abonos o con permitir → pasa', async () => {
    const e = await errorDe(conAbonos(25.5, 'bloquear').exigirAnulacionCreditoPermitida(9));
    expect([e.codigo, e.estadoHttp]).toEqual(['ANULACION_CREDITO_CON_ABONOS', 409]);
    expect(e.message).toBe('Esta venta a crédito ya tiene abonos por S/ 25.50. Emita una nota de crédito y registre la devolución de lo abonado.');
    await expect(conAbonos(0, 'bloquear').exigirAnulacionCreditoPermitida(9)).resolves.toBeUndefined();
    await expect(conAbonos(25.5, 'permitir').exigirAnulacionCreditoPermitida(9)).resolves.toBeUndefined();
  });
});
