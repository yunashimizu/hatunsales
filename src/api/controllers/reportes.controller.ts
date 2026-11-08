import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RegistroVentasArchivo, ReportesBussnies } from '../../bussnies/Bussnies/reportes.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { ResumenDiarioBussnies } from '../../bussnies/Bussnies/resumen-diario.bussnies';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

/** Entero positivo de un parámetro de la URL; cualquier otra cosa (vacío, texto, 0) es «sin filtro». */
function enteroPositivo(valor?: string): number | undefined {
  if (valor === undefined || valor === '') return undefined;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

@Controller('reportes')
export class ReportesController {
  constructor(
    private readonly service: ReportesBussnies,
    private readonly resumenDiario: ResumenDiarioBussnies,
  ) {}

  @Get('ventas')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  ventas(
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
    @Query('id_cliente') id_cliente?: string,
    @Query('id_tipo') id_tipo?: string,
    @Query('id_moneda') id_moneda?: string,
  ) {
    return this.service.reporteVentas(periodo, {
      fecha_inicio,
      fecha_fin,
      id_cliente: enteroPositivo(id_cliente),
      id_tipo: enteroPositivo(id_tipo),
      id_moneda: enteroPositivo(id_moneda),
    });
  }

  /** Ventas netas por hora de Lima (fecha opcional, por defecto hoy) frente al mismo día de la semana anterior. */
  @Get('ventas-por-hora')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  ventasPorHora(@Query('fecha') fecha?: string) {
    return this.service.ventasPorHora(fecha);
  }

  /** Mapa de calor hora × día de la semana de las últimas `semanas` semanas (por defecto 4). */
  @Get('ventas-mapa-calor')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  ventasMapaCalor(@Query('semanas') semanas?: string) {
    return this.service.ventasMapaCalor(semanas);
  }

  /** Rentabilidad por producto y por categoría del rango (sin fechas, el mes en curso). Solo el administrador ve costos. */
  @Get('productos')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  rentabilidadProductos(@Query('fecha_inicio') fecha_inicio?: string, @Query('fecha_fin') fecha_fin?: string) {
    return this.service.rentabilidadProductos({ fecha_inicio, fecha_fin });
  }

  /** Productos con existencias sin ventas en 30, 60 o 90 días. */
  @Get('productos/estancados')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  productosEstancados(@Query('dias') dias?: string) {
    return this.service.productosEstancados(dias);
  }

  @Get('resumen-diario/configuracion')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  resumenDiarioConfiguracion() {
    return this.resumenDiario.obtenerConfiguracion();
  }

  @Put('resumen-diario/configuracion')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  guardarResumenDiarioConfiguracion(@Body() body: { activo?: boolean; hora?: string; correos?: string[] | string }) {
    return this.resumenDiario.guardarConfiguracion(body ?? {});
  }

  /** Arma el resumen de hoy y lo envía ya a los destinatarios (prueba); no marca el día como enviado. */
  @Post('resumen-diario/enviar-ahora')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  enviarResumenDiarioAhora() {
    return this.resumenDiario.enviarAhora();
  }

  @Get('categorias')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  categorias(@Query('periodo') periodo = 'mensual') {
    return this.service.reportePorCategoria({ periodo });
  }

  /** Excel del reporte: respeta los mismos filtros que la pantalla (periodo, rango, tipo de comprobante). */
  @Get('ventas/excel')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async ventasExcel(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
    @Query('id_cliente') id_cliente?: string,
    @Query('id_tipo') id_tipo?: string,
    @Query('id_moneda') id_moneda?: string,
  ) {
    try {
      const { buffer, filename } = await this.service.exportVentasExcel(periodo, {
        fecha_inicio,
        fecha_fin,
        id_cliente: enteroPositivo(id_cliente),
        id_tipo: enteroPositivo(id_tipo),
        id_moneda: enteroPositivo(id_moneda),
      });
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    } catch (e) {
      return this.responderErrorExport(res, e, 'No se pudo exportar el Excel');
    }
  }

  /** PDF del reporte: respeta los mismos filtros que la pantalla (periodo, rango, tipo de comprobante). */
  @Get('ventas/pdf')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async ventasPdf(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
    @Query('id_cliente') id_cliente?: string,
    @Query('id_tipo') id_tipo?: string,
    @Query('id_moneda') id_moneda?: string,
  ) {
    try {
      const { buffer, filename } = await this.service.exportVentasPdf(periodo, {
        fecha_inicio,
        fecha_fin,
        id_cliente: enteroPositivo(id_cliente),
        id_tipo: enteroPositivo(id_tipo),
        id_moneda: enteroPositivo(id_moneda),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    } catch (e) {
      return this.responderErrorExport(res, e, 'No se pudo exportar el PDF');
    }
  }

  /**
   * Registro de ventas para el SIRE (RVIE) del mes `periodo` (AAAAMM): TXT con la estructura de importación.
   * El resumen (qué quedó fuera y por qué) viaja en `X-Rvie-Resumen` (JSON con encodeURIComponent).
   */
  @Get('ventas/rvie')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async ventasRvie(@Res() res: Response, @Query('periodo') periodo?: string) {
    try {
      return this.enviarRegistroVentas(res, await this.service.registroVentasRvie(periodo ?? ''));
    } catch (e) {
      return this.responderErrorExport(res, e, 'No se pudo generar el registro de ventas');
    }
  }

  /** Las mismas filas del registro de ventas en CSV con cabeceras (para el contador). */
  @Get('ventas/rvie.csv')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async ventasRvieCsv(@Res() res: Response, @Query('periodo') periodo?: string) {
    try {
      return this.enviarRegistroVentas(res, await this.service.registroVentasRvieCsv(periodo ?? ''));
    } catch (e) {
      return this.responderErrorExport(res, e, 'No se pudo generar el registro de ventas');
    }
  }

  private enviarRegistroVentas(res: Response, archivo: RegistroVentasArchivo) {
    res.setHeader('Content-Type', archivo.tipo);
    res.setHeader('Content-Disposition', `attachment; filename="${archivo.nombre}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Rvie-Resumen');
    res.setHeader('X-Rvie-Resumen', encodeURIComponent(JSON.stringify(archivo.resumen)));
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(archivo.contenido, 'utf8'));
  }

  private responderErrorExport(res: Response, e: unknown, fallback: string) {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse();
      return res.status(status).json(typeof body === 'string' ? { message: body } : body);
    }
    return res.status(400).json(
      cuerpoError(CodigoError.REPORTE_EXPORT_FALLIDA, fallback),
    );
  }
}
