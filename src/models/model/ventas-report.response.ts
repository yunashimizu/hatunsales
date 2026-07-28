export class VentasReportDetalle {
  /** Campos legacy (compatibles con Excel/PDF antiguos). */
  fecha!: string;
  cantidad_comprobantes!: number;
  total_vendido!: number;

  /** Campos enriquecidos para la UI de reportes. */
  id_comprobante?: number;
  serie?: string;
  numero?: number;
  numero_formateado?: string;
  cliente?: string;
  documento_cliente?: string;
  estado?: string;
  anulado?: boolean;
}

export class VentasSeriePunto {
  clave!: string;
  etiqueta!: string;
  total!: number;
  cantidad!: number;
}

export class VentasTopCliente {
  cliente!: string;
  documento?: string;
  total!: number;
  cantidad!: number;
}

export class VentasEstadisticas {
  venta_maxima!: number;
  venta_minima!: number;
  emitidos!: number;
  anulados!: number;
  con_error!: number;
  dias_con_venta!: number;
  serie!: VentasSeriePunto[];
  top_clientes!: VentasTopCliente[];
  plan!: string;
}

export class VentasReportResponse {
  periodo!: string;
  fecha_inicio!: string;
  fecha_fin!: string;
  cantidad_comprobantes!: number;
  total_vendido!: number;
  ticket_promedio!: number;
  detalle!: VentasReportDetalle[];
  estadisticas!: VentasEstadisticas;
}
