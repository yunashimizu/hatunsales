export class ProformaResponse {
  id_proforma?: number;
  id_empresa!: number;
  id_cliente!: number;
  serie!: string;
  numero!: number;
  total_gravada!: number;
  total_igv!: number;
  total!: number;
  items!: Array<{ id_producto: number; cantidad: number; precio_unitario: number }>;
  creado_en?: Date;
}
