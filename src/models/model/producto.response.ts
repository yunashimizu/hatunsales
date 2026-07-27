export class ProductoResponse {
  id_producto?: number;
  nombre!: string;
  descripcion?: string;
  descripcion_corta?: string;
  codigo_barras?: string;
  sku?: string;
  precio_compra?: number;
  precio_venta?: number;
  descuento?: number;
  unidad_medida?: string;
  id_proveedor?: number;
  id_categoria?: number;
  categoria?: string;
  id_marca?: number;
  marca?: string;
  estado?: boolean;
  destacado?: boolean;
  /** Imagen principal, o la primera del orden si ninguna está marcada. */
  imagen_url?: string;
  thumb_url?: string;
  total_imagenes?: number;
  /** Suma del stock en todos los almacenes. */
  stock_total?: number;
  creado_en?: Date;
}
