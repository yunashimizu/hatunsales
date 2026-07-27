/**
 * Motor de cálculo fiscal. Es la única fuente de verdad para convertir precios
 * de venta en las cifras que exige un comprobante electrónico.
 *
 * Regla del negocio: `productos.precio_venta` y todo precio que se muestra al
 * público YA incluyen IGV. El impuesto se desagrega hacia atrás, nunca se suma
 * encima. Así una boleta y una factura por la misma compra dan el mismo total.
 *
 * El IGV de cada línea se obtiene restando la base al total, no multiplicando
 * la base por la tasa. Multiplicar produce diferencias de un céntimo que hacen
 * que la suma de las líneas no coincida con los totales, y NUBEFACT rechaza el
 * comprobante por esa razón.
 */

/** Catálogo 07 de SUNAT, en la codificación que espera NUBEFACT. */
export const TIPO_IGV_GRAVADO = 1;
export const TIPO_IGV_EXONERADO = 8;
export const TIPO_IGV_INAFECTO = 9;

export const PORCENTAJE_IGV_POR_DEFECTO = 18;

/** Decimales que admite NUBEFACT en el valor unitario. */
const DECIMALES_VALOR_UNITARIO = 6;

export interface LineaFiscalEntrada {
  cantidad: number;
  /** Precio unitario CON IGV, tal como se le cobra al cliente. */
  precio_unitario: number;
  /** Descuento sobre la línea, en soles y CON IGV. */
  descuento?: number;
  tipo_de_igv?: number;
}

export interface LineaFiscal {
  cantidad: number;
  /** Precio unitario sin IGV. Es la columna V/U de la factura. */
  valor_unitario: number;
  /** Precio unitario con IGV. Es la columna P/U. */
  precio_unitario: number;
  descuento: number;
  /** Base imponible de la línea, sin IGV. */
  subtotal: number;
  igv: number;
  /** Lo que realmente paga el cliente por esta línea. */
  total: number;
  tipo_de_igv: number;
}

export interface ResumenFiscal {
  lineas: LineaFiscal[];
  total_gravada: number;
  total_exonerada: number;
  total_inafecta: number;
  total_descuento: number;
  total_igv: number;
  total: number;
  porcentaje_igv: number;
}

export function redondear(valor: number, decimales = 2): number {
  if (!Number.isFinite(valor)) return 0;
  const factor = 10 ** decimales;
  const signo = valor < 0 ? -1 : 1;
  return (signo * Math.round(Math.abs(valor) * factor + Number.EPSILON)) / factor;
}

/**
 * Desagrega un monto que ya incluye IGV. Devuelve base e impuesto de forma que
 * la suma de ambos siempre reconstruye exactamente el monto original.
 */
export function desagregarIgv(
  totalConIgv: number,
  porcentajeIgv = PORCENTAJE_IGV_POR_DEFECTO,
): { subtotal: number; igv: number } {
  const total = redondear(totalConIgv);
  const subtotal = redondear(total / (1 + porcentajeIgv / 100));
  return { subtotal, igv: redondear(total - subtotal) };
}

function normalizarTipoIgv(tipo?: number): number {
  if (tipo === TIPO_IGV_EXONERADO || tipo === TIPO_IGV_INAFECTO) return tipo;
  return TIPO_IGV_GRAVADO;
}

function calcularLinea(
  entrada: LineaFiscalEntrada,
  porcentajeIgv: number,
): LineaFiscal {
  const cantidad = Number(entrada.cantidad) || 0;
  const precioUnitario = redondear(Number(entrada.precio_unitario) || 0);
  const tipoIgv = normalizarTipoIgv(entrada.tipo_de_igv);

  const bruto = redondear(precioUnitario * cantidad);
  // El descuento nunca puede dejar la línea en negativo.
  const descuento = Math.min(redondear(Number(entrada.descuento) || 0), bruto);
  const total = redondear(bruto - descuento);

  const { subtotal, igv } =
    tipoIgv === TIPO_IGV_GRAVADO
      ? desagregarIgv(total, porcentajeIgv)
      : { subtotal: total, igv: 0 };

  return {
    cantidad,
    valor_unitario: cantidad > 0 ? redondear(subtotal / cantidad, DECIMALES_VALOR_UNITARIO) : 0,
    precio_unitario: precioUnitario,
    descuento,
    subtotal,
    igv,
    total,
    tipo_de_igv: tipoIgv,
  };
}

export function calcularComprobante(
  entradas: LineaFiscalEntrada[],
  porcentajeIgv = PORCENTAJE_IGV_POR_DEFECTO,
): ResumenFiscal {
  const tasa = Number.isFinite(porcentajeIgv) && porcentajeIgv >= 0
    ? porcentajeIgv
    : PORCENTAJE_IGV_POR_DEFECTO;

  const lineas = (entradas ?? []).map((entrada) => calcularLinea(entrada, tasa));

  const acumular = (filtro: (l: LineaFiscal) => boolean, campo: keyof LineaFiscal) =>
    redondear(lineas.filter(filtro).reduce((suma, l) => suma + Number(l[campo]), 0));

  const total_gravada = acumular((l) => l.tipo_de_igv === TIPO_IGV_GRAVADO, 'subtotal');
  const total_exonerada = acumular((l) => l.tipo_de_igv === TIPO_IGV_EXONERADO, 'subtotal');
  const total_inafecta = acumular((l) => l.tipo_de_igv === TIPO_IGV_INAFECTO, 'subtotal');
  const total_igv = acumular(() => true, 'igv');
  const total_descuento = acumular(() => true, 'descuento');
  const total = acumular(() => true, 'total');

  return {
    lineas,
    total_gravada,
    total_exonerada,
    total_inafecta,
    total_descuento,
    total_igv,
    total,
    porcentaje_igv: tasa,
  };
}
