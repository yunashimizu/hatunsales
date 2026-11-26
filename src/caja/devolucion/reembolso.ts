import { Dinero } from '../dominio/dinero';
import type { EfectivoDeVenta } from './devolucion-caja.repository';

/**
 * Cuánto efectivo se puede devolver desde la caja por una venta (Fase 7.1, corregida por R8). Utilidad pura.
 *
 * El efectivo esperado de un turno ya EXCLUYE las ventas anuladas que caen en él (`vs.estado <> 'anulada'`
 * en sql-esperado.ts). Por eso:
 *  - Anulación de una venta que cae en un turno ABIERTO (el de quien devuelve o el de otra caja): lo cobrado
 *    en esa venta NO genera egreso; la anulación ya lo descuenta de ese turno. Un egreso sería descontarlo
 *    dos veces.
 *  - Anulación de una venta de un turno CERRADO (o sin turno: caja «blanda»): el efectivo sale del turno
 *    abierto de quien devuelve → egreso.
 *  - Devolución parcial (nota de crédito que no anula la venta): la venta sigue activa y su cobro sigue
 *    contando en su turno → egreso siempre.
 *  - Los abonos de crédito cobrados en efectivo cuentan en el turno de quien los cobró aunque la venta se
 *    anule (sql-esperado no mira el estado de la venta para los abonos) → su devolución es egreso siempre.
 * En todos los casos se resta lo ya devuelto con egresos enlazados a la venta (movimientos_caja.id_venta).
 */
export type TipoDevolucion = 'anulacion' | 'parcial';

export interface CalculoReembolsable {
  /** Lo que todavía se puede devolver con un egreso (nunca negativo). */
  maximo: Dinero;
  /** La venta cae en un turno abierto: anularla ya la descuenta de ese turno. */
  venta_en_turno_abierto: boolean;
  /** Parte de lo cobrado que la anulación descuenta sola (no admite egreso). */
  descontado_por_anulacion: Dinero;
}

export function calcularReembolsable(d: EfectivoDeVenta, tipo: TipoDevolucion): CalculoReembolsable {
  const enTurnoAbierto = d.turno?.abierto === true;
  const sinEgresoPorAnular = tipo === 'anulacion' && enTurnoAbierto;
  const base = sinEgresoPorAnular ? d.abonos_efectivo : d.efectivo_venta.sumar(d.abonos_efectivo);
  const yaDevuelto = d.ya_reembolsado ?? Dinero.CERO;
  const resto = base.restar(yaDevuelto);
  return {
    maximo: resto.esPositivo() ? resto : Dinero.CERO,
    venta_en_turno_abierto: enTurnoAbierto,
    descontado_por_anulacion: sinEgresoPorAnular ? d.efectivo_venta : Dinero.CERO,
  };
}

/** Descripción legible del egreso (movimientos_caja.descripcion, máximo 200). */
export function descripcionDevolucion(idVenta: number, detalle?: string | null): string {
  const extra = String(detalle ?? '').trim();
  return `Devolución de la venta ${idVenta}${extra ? ` · ${extra}` : ''}`.slice(0, 200);
}
