import { redondear } from '../fiscal/calculo-fiscal';

/** Clave de `configuraciones` con el recargo (en %) por cobrar con tarjeta. 0 lo desactiva. */
export const CLAVE_RECARGO_TARJETA_PCT = 'pos_recargo_tarjeta_pct';
export const RECARGO_TARJETA_PCT_DEFECTO = 3;

/** La línea del recargo en el comprobante es un servicio (catálogo 03: ZZ) de cantidad 1. */
export const CODIGO_RECARGO_TARJETA = 'RECARGO-TARJETA';
export const UNIDAD_RECARGO_TARJETA = 'ZZ';
export const DESCRIPCION_RECARGO_TARJETA = 'RECARGO POR PAGO CON TARJETA';

export interface PagoParaRecargo {
  /** true si el medio de pago es una tarjeta (cobro en el POS físico). */
  tarjeta: boolean;
  /** Monto escrito en la línea de pago; 0 = todavía sin definir. */
  monto: number;
}

export interface RecargoTarjeta {
  aplica: boolean;
  porcentaje: number;
  /** Parte de la venta (con IGV, sin recargo) que se cobra con tarjeta. */
  base_tarjeta: number;
  /** Recargo con IGV incluido: lo que el cliente paga de más. */
  monto: number;
}

export interface TramoRecargo {
  /** Catálogo 07 en la codificación del sistema: 1 gravado, 8 exonerado, 9 inafecto. */
  tipo_de_igv: number;
  /** Parte del recargo (con IGV) que sigue el tratamiento tributario de ese tramo. */
  monto: number;
}

/** Medio de pago de tipo tarjeta: mismo criterio que usa la validación del cobro. */
export function esMetodoTarjeta(metodo: { tipo?: string | null; nombre?: string | null }): boolean {
  const tipo = String(metodo.tipo ?? '').trim().toLowerCase();
  const nombre = String(metodo.nombre ?? '').trim().toLowerCase();
  return tipo === 'tarjeta' || nombre.includes('tarjeta');
}

/** Un valor no numérico o negativo desactiva el recargo; nunca pasa de 100 %. */
export function normalizarPorcentajeRecargo(valor: unknown): number {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return 0;
  return Math.min(100, redondear(numero));
}

/**
 * El recargo se cobra solo sobre la parte de la venta que se paga con tarjeta:
 * lo que no cubren los demás medios (efectivo, Yape, crédito…). Con un solo
 * pago con tarjeta es el total de la venta. El monto de la línea de tarjeta es
 * el que se pasa por la maquinita: base + recargo.
 */
export function calcularRecargoTarjeta(
  totalSinRecargo: number,
  pagos: PagoParaRecargo[],
  porcentaje: number,
): RecargoTarjeta {
  const pct = normalizarPorcentajeRecargo(porcentaje);
  const ninguno: RecargoTarjeta = { aplica: false, porcentaje: pct, base_tarjeta: 0, monto: 0 };
  const total = redondear(Number(totalSinRecargo) || 0);
  if (!(pct > 0) || !(total > 0) || !pagos.some((pago) => pago.tarjeta)) return ninguno;

  const otrosMedios = redondear(
    pagos
      .filter((pago) => !pago.tarjeta)
      .reduce((suma, pago) => suma + Math.max(0, Number(pago.monto) || 0), 0),
  );
  const base = redondear(Math.max(0, total - otrosMedios));
  const monto = redondear((base * pct) / 100);
  return monto > 0 ? { aplica: true, porcentaje: pct, base_tarjeta: base, monto } : { ...ninguno, base_tarjeta: base };
}

/**
 * Reparte el recargo entre los tratamientos de IGV de la venta, en proporción a
 * lo que vale cada uno, para que cada parte siga el mismo tratamiento que los
 * productos que la originan. Lo habitual es un solo tramo gravado. El reparto
 * se hace en céntimos y siempre suma exactamente `monto`.
 */
export function repartirRecargoPorAfectacion(
  lineas: { tipo_de_igv: number; total: number }[],
  monto: number,
): TramoRecargo[] {
  const centimos = Math.round(redondear(Number(monto) || 0) * 100);
  if (centimos <= 0) return [];

  const tramos = new Map<number, number>();
  for (const linea of lineas) {
    const valor = Math.round(redondear(Number(linea.total) || 0) * 100);
    if (valor > 0) tramos.set(linea.tipo_de_igv, (tramos.get(linea.tipo_de_igv) ?? 0) + valor);
  }
  if (!tramos.size) return [{ tipo_de_igv: 1, monto: centimos / 100 }];
  if (tramos.size === 1) return [{ tipo_de_igv: [...tramos.keys()][0], monto: centimos / 100 }];

  const suma = [...tramos.values()].reduce((a, b) => a + b, 0);
  const partes = [...tramos].map(([tipo, valor], orden) => {
    const exacto = (centimos * valor) / suma;
    return { tipo, orden, entero: Math.floor(exacto), resto: exacto - Math.floor(exacto) };
  });
  let faltan = centimos - partes.reduce((a, p) => a + p.entero, 0);
  for (const parte of [...partes].sort((a, b) => b.resto - a.resto || a.orden - b.orden)) {
    if (faltan <= 0) break;
    parte.entero += 1;
    faltan -= 1;
  }
  return partes
    .filter((parte) => parte.entero > 0)
    .map((parte) => ({ tipo_de_igv: parte.tipo, monto: parte.entero / 100 }));
}
