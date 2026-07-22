export class GuiaRemisionResponse {
  id_guia?: number;
  id_empresa!: number;
  id_cliente!: number;
  direccion_origen!: string;
  direccion_destino!: string;
  motivo_traslado!: string;
  peso_total!: string;
  items!: Array<{ id_producto: number; cantidad: number; unidad_medida: string }>;
  creado_en?: Date;
}
