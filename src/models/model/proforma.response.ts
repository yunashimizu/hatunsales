export class ProformaItemResponse {
  id_producto!: number;
  cantidad!: number;
  precio_unitario!: number;
  subtotal?: number;
  descripcion?: string;
  sku?: string;
}

export class ProformaResponse {
  id_proforma!: number;
  codigo?: string | null;
  estado!: string;
  id_empresa?: number | null;
  id_cliente?: number | null;
  cliente_nombre?: string | null;
  telefono_envio?: string | null;
  id_almacen?: number | null;
  observaciones?: string | null;
  valida_hasta?: string | null;
  serie?: string | null;
  numero?: number | null;
  total_gravada!: number;
  total_igv!: number;
  total!: number;
  id_venta?: number | null;
  enviada_wa_en?: Date | string | null;
  items!: ProformaItemResponse[];
  creado_en?: Date;
}
