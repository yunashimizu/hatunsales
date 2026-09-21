import { redondear } from '../fiscal/calculo-fiscal';

export interface ReglaMayorista {
  id_regla: number;
  cantidad_minima: number;
  descuento_unitario: number;
}

export interface EntradaPrecioVenta {
  precio_lista: number;
  descuento_producto: number;
  cantidad: number;
  reglas_mayoristas?: ReglaMayorista[];
}

export interface ResultadoPrecioVenta {
  precio_lista_unitario: number;
  descuento_unitario_aplicado: number;
  descuento_total_linea: number;
  precio_unitario_final: number;
  total_linea: number;
  tipo_regla: 'ninguno' | 'producto' | 'mayorista';
  id_regla_mayorista: number | null;
}

/** Resuelve una línea: la regla mayorista reemplaza al descuento normal. */
export function resolverPrecioVenta(entrada: EntradaPrecioVenta): ResultadoPrecioVenta {
  const precioLista = redondear(Math.max(0, Number(entrada.precio_lista) || 0));
  const cantidad = Math.max(0, Number(entrada.cantidad) || 0);
  const descuentoProducto = Math.min(precioLista, redondear(Math.max(0, Number(entrada.descuento_producto) || 0)));
  const reglas = (entrada.reglas_mayoristas ?? [])
    .filter((regla) => Number(regla.cantidad_minima) > 0 && Number(regla.descuento_unitario) >= 0)
    .filter((regla) => Number(regla.cantidad_minima) <= cantidad)
    .sort((a, b) => Number(b.cantidad_minima) - Number(a.cantidad_minima));
  const mayorista = reglas[0];
  const descuentoUnitario = mayorista
    ? Math.min(precioLista, redondear(Number(mayorista.descuento_unitario)))
    : descuentoProducto;
  const totalDescuento = redondear(descuentoUnitario * cantidad);
  const precioFinal = redondear(precioLista - descuentoUnitario);

  return {
    precio_lista_unitario: precioLista,
    descuento_unitario_aplicado: descuentoUnitario,
    descuento_total_linea: totalDescuento,
    precio_unitario_final: precioFinal,
    total_linea: redondear(precioFinal * cantidad),
    tipo_regla: mayorista ? 'mayorista' : (descuentoProducto > 0 ? 'producto' : 'ninguno'),
    id_regla_mayorista: mayorista ? Number(mayorista.id_regla) : null,
  };
}