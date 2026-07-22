export class VentasReportDetalle {
  fecha!: string;
  cantidad_comprobantes!: number;
  total_vendido!: number;
}

export class VentasReportResponse {
  periodo!: string;
  fecha_inicio!: string;
  fecha_fin!: string;
  cantidad_comprobantes!: number;
  total_vendido!: number;
  detalle!: VentasReportDetalle[];
}
