export class ProductoResponse {
  id_producto?: number;
  nombre!: string;
  descripcion?: string;
  codigo_barras?: string;
  precio_compra?: number;
  precio_venta?: number;
  unidad_medida?: string;
  id_proveedor?: number;
  creado_en?: Date;
}
