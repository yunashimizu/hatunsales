import { VentasReportResponse } from '../../models/model/ventas-report.response';

type ReportesFilters = {
  fecha_inicio?: string;
  fecha_fin?: string;
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

export interface IReportesBussniees {
  reporteVentas(
    periodo: 'diario' | 'semana' | 'quincenal' | 'mensual',
    filters: ReportesFilters,
  ): Promise<VentasReportResponse>;
}
