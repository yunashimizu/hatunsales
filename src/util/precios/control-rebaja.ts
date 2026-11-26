import { ReglaMayorista, resolverPrecioVenta } from './precio-venta';

/**
 * Control de rebajas del punto de venta (plan «Escribir menos y vender con control», Fase 6.4, R3–R6).
 *
 * Funciones puras: sin base de datos ni Nest. Miden cada línea contra el **precio de catálogo neto que
 * calcula el servidor** (precio de venta y descuento guardados en el producto, más la regla mayorista
 * de esa cantidad), nunca contra lo que manda el navegador. El descuento de la ficha y la regla
 * mayorista no son rebaja manual; vender más caro nunca es rebaja.
 */

export type ModoControlRebaja = 'registrar' | 'autorizar' | 'apagado';

export const MODOS_CONTROL_REBAJA: readonly ModoControlRebaja[] = ['registrar', 'autorizar', 'apagado'];

/** Claves de `configuraciones`. Sin la clave vale el valor por defecto (SQL-6 no las inserta). */
export const CLAVES_CONTROL_REBAJA = {
  modo: 'control_rebaja_modo',
  tope: 'rebaja_max_pct_vendedor',
  bajoCosto: 'control_bajo_costo',
} as const;

export interface ConfigControlRebaja {
  modo: ModoControlRebaja;
  /** % máximo de rebaja manual sobre el precio de catálogo neto para quien no es admin. */
  tope_pct: number;
  /** ¿Se controla vender por debajo del costo? */
  bajo_costo: boolean;
}

/** D1 y D2: nace en `registrar` (anota, no bloquea), tope 10 %, bajo costo controlado. */
export const CONFIG_CONTROL_REBAJA_POR_DEFECTO: Readonly<ConfigControlRebaja> = Object.freeze({
  modo: 'registrar',
  tope_pct: 10,
  bajo_costo: true,
});

/** Tolerancia de redondeo: una diferencia de hasta 1 céntimo no cuenta. */
export const TOLERANCIA_CENTIMOS = 1;

const VERDADEROS = new Set(['true', '1', 'si', 'sí', 'yes', 'on']);
const FALSOS = new Set(['false', '0', 'no', 'off']);

/** Texto de configuración → modo. Lo desconocido o vacío es el modo por defecto (`registrar`). */
export function normalizarModoControl(valor: unknown): ModoControlRebaja {
  const texto = String(valor ?? '').trim().toLowerCase();
  return (MODOS_CONTROL_REBAJA as readonly string[]).includes(texto)
    ? (texto as ModoControlRebaja)
    : CONFIG_CONTROL_REBAJA_POR_DEFECTO.modo;
}

/** Tope en %, entre 0 y 100 con 2 decimales. Vacío, no numérico o fuera de rango → 10. */
export function normalizarTopeRebaja(valor: unknown): number {
  if (valor === null || valor === undefined || String(valor).trim() === '') return CONFIG_CONTROL_REBAJA_POR_DEFECTO.tope_pct;
  const numero = Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(numero) || numero < 0 || numero > 100) return CONFIG_CONTROL_REBAJA_POR_DEFECTO.tope_pct;
  return Math.round(numero * 100) / 100;
}

/** Sí/no de configuración. Lo que no se reconoce es el valor por defecto. */
export function normalizarSiNo(valor: unknown, porDefecto: boolean): boolean {
  if (typeof valor === 'boolean') return valor;
  const texto = String(valor ?? '').trim().toLowerCase();
  if (VERDADEROS.has(texto)) return true;
  if (FALSOS.has(texto)) return false;
  return porDefecto;
}

/** Configuración desde los valores crudos de `configuraciones` (null = clave ausente). */
export function configControlDesdeValores(valores: Readonly<Record<string, string | null | undefined>>): ConfigControlRebaja {
  return {
    modo: normalizarModoControl(valores[CLAVES_CONTROL_REBAJA.modo]),
    tope_pct: normalizarTopeRebaja(valores[CLAVES_CONTROL_REBAJA.tope]),
    bajo_costo: normalizarSiNo(valores[CLAVES_CONTROL_REBAJA.bajoCosto], CONFIG_CONTROL_REBAJA_POR_DEFECTO.bajo_costo),
  };
}

/** Una línea de la venta con lo que pidió el mostrador y los datos del producto EN LA BASE. */
export interface LineaParaControl {
  id_producto: number;
  descripcion: string;
  cantidad: number;
  /** Precio unitario final pedido (con IGV, después de descuentos), tal como se va a cobrar. */
  precio_final: number;
  /** `productos.precio_venta` (base). */
  precio_venta_base: number;
  /** `productos.descuento` (base, soles por unidad). */
  descuento_base: number;
  reglas_mayoristas?: ReglaMayorista[];
  /** `productos.precio_compra` (> 0) o null si no tiene costo. */
  costo_unitario: number | null;
}

/** Resultado por línea. `costo_unitario` es interno: no viaja a caja ni a vendedor (ver `rebajaVisible`). */
export interface EvaluacionRebaja {
  /** Posición de la línea en el carrito (0 = primera). */
  indice: number;
  id_producto: number;
  descripcion: string;
  cantidad: number;
  /** Precio de catálogo neto que calcula el servidor; null si el producto no tiene precio en la base. */
  precio_referencia: number | null;
  precio_final: number;
  /** % de rebaja manual sobre la referencia (0 si no la hay o si se vende más caro). */
  rebaja_pct: number;
  sobre_tope: boolean;
  bajo_costo: boolean;
  costo_unitario: number | null;
}

/** Lo que puede ver el mostrador: sin el costo, solo la señal «bajo costo». */
export interface RebajaVisible {
  indice: number;
  id_producto: number;
  descripcion: string;
  cantidad: number;
  precio_referencia: number | null;
  precio_final: number;
  rebaja_pct: number;
  tope_pct: number;
  sobre_tope: boolean;
  bajo_costo: boolean;
  requiere_autorizacion: boolean;
}

const centimos = (valor: number) => Math.round((Number(valor) || 0) * 100);

/** Precio de catálogo neto para esa cantidad (precio y descuento de la base + regla mayorista). null = sin referencia. */
export function precioReferencia(linea: Pick<LineaParaControl, 'precio_venta_base' | 'descuento_base' | 'cantidad' | 'reglas_mayoristas'>): number | null {
  const resuelto = resolverPrecioVenta({
    precio_lista: Number(linea.precio_venta_base) || 0,
    descuento_producto: Number(linea.descuento_base) || 0,
    cantidad: Number(linea.cantidad) || 0,
    reglas_mayoristas: linea.reglas_mayoristas ?? [],
  });
  if (!(resuelto.precio_lista_unitario > 0) || !(resuelto.precio_unitario_final > 0)) return null;
  return resuelto.precio_unitario_final;
}

/** Evalúa una línea con la configuración dada (sin mirar el modo: eso lo decide `evaluarRebajas`). */
export function evaluarLinea(linea: LineaParaControl, indice: number, config: ConfigControlRebaja): EvaluacionRebaja {
  const referencia = precioReferencia(linea);
  const precioFinal = Math.round((Number(linea.precio_final) || 0) * 100) / 100;

  let rebajaPct = 0;
  let sobreTope = false;
  if (referencia !== null) {
    const rebajaCent = centimos(referencia) - centimos(precioFinal);
    if (rebajaCent > TOLERANCIA_CENTIMOS) {
      rebajaPct = Math.round((rebajaCent / centimos(referencia)) * 10000) / 100;
      // Permitido = tope % de la referencia, más 1 céntimo de tolerancia (redondeos del POS).
      const permitidoCent = (centimos(referencia) * config.tope_pct) / 100;
      sobreTope = rebajaCent > permitidoCent + TOLERANCIA_CENTIMOS + 1e-9;
    }
  }

  const costo = linea.costo_unitario !== null && linea.costo_unitario !== undefined ? Number(linea.costo_unitario) : null;
  // Misma comparación directa que la ficha del producto: precio < costo, solo con costo cargado (> 0).
  const bajoCosto = config.bajo_costo && costo !== null && Number.isFinite(costo) && costo > 0 && precioFinal + 1e-9 < costo;

  return {
    indice,
    id_producto: Number(linea.id_producto),
    descripcion: String(linea.descripcion ?? ''),
    cantidad: Number(linea.cantidad) || 0,
    precio_referencia: referencia,
    precio_final: precioFinal,
    rebaja_pct: rebajaPct,
    sobre_tope: sobreTope,
    bajo_costo: bajoCosto,
    costo_unitario: costo !== null && Number.isFinite(costo) && costo > 0 ? costo : null,
  };
}

/** Líneas afectadas (sobre el tope o bajo costo). Con el control apagado, ninguna. */
export function evaluarRebajas(lineas: readonly LineaParaControl[], config: ConfigControlRebaja): EvaluacionRebaja[] {
  if (config.modo === 'apagado') return [];
  return lineas
    .map((linea, indice) => evaluarLinea(linea, indice, config))
    .filter((e) => e.sobre_tope || e.bajo_costo);
}

/** En modo `autorizar`, cualquier línea afectada pide el permiso de un administrador. */
export function requiereAutorizacion(rebajas: readonly EvaluacionRebaja[], config: ConfigControlRebaja): boolean {
  return config.modo === 'autorizar' && rebajas.length > 0;
}

/** Vista para caja y vendedor: nunca el valor del costo. */
export function rebajaVisible(e: EvaluacionRebaja, config: ConfigControlRebaja): RebajaVisible {
  return {
    indice: e.indice,
    id_producto: e.id_producto,
    descripcion: e.descripcion,
    cantidad: e.cantidad,
    precio_referencia: e.precio_referencia,
    precio_final: e.precio_final,
    rebaja_pct: e.rebaja_pct,
    tope_pct: config.tope_pct,
    sobre_tope: e.sobre_tope,
    bajo_costo: e.bajo_costo,
    requiere_autorizacion: config.modo === 'autorizar',
  };
}

const soles = (n: number) => `S/ ${n.toFixed(2)}`;

/** Frase corta por línea para el mensaje del 409 (sin costo). */
export function describirRebaja(e: EvaluacionRebaja, config: ConfigControlRebaja): string {
  const partes: string[] = [];
  if (e.sobre_tope && e.precio_referencia !== null) {
    partes.push(`${soles(e.precio_final)} en vez de ${soles(e.precio_referencia)}: ${e.rebaja_pct}% de rebaja, el tope es ${config.tope_pct}%`);
  }
  if (e.bajo_costo) partes.push('por debajo del costo');
  return `${e.descripcion} (${partes.join('; ')})`;
}
