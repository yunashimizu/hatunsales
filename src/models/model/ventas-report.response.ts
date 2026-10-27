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

/** Reparto de lo vendido por tipo de comprobante. `total` lleva signo: la nota de crédito resta. */
export class VentasPorTipo {
  id_tipo!: number;
  tipo!: string;
  cantidad!: number;
  total!: number;
}

/** Producto del ranking de lo vendido en el periodo (neto de notas de crédito). */
export class VentasTopProducto {
  id_producto!: number | null;
  codigo!: string;
  producto!: string;
  cantidad!: number;
  total!: number;
  /** En cuántos comprobantes aparece. */
  comprobantes!: number;
}

/** Producto del ranking de cotizaciones (proformas no anuladas) del periodo. */
export class VentasTopProductoCotizado {
  id_producto!: number | null;
  sku!: string;
  producto!: string;
  /** En cuántas cotizaciones aparece. */
  cotizaciones!: number;
  cantidad!: number;
  total!: number;
  /** Cuántas de esas cotizaciones llegaron a ser una venta. */
  convertidas!: number;
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
