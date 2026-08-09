import {
  Controller,
  Get,
  HttpException,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReportesBussnies } from '../../bussnies/Bussnies/reportes.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

@Controller('reportes')
export class ReportesController {
  constructor(private readonly service: ReportesBussnies) {}

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
      id_cliente: id_cliente ? Number(id_cliente) : undefined,
      id_tipo: id_tipo ? Number(id_tipo) : undefined,
      id_moneda: id_moneda ? Number(id_moneda) : undefined,
    });
  }

  @Get('categorias')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  categorias(@Query('periodo') periodo = 'mensual') {
    return this.service.reportePorCategoria({ periodo });
  }

  @Get('ventas/excel')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async ventasExcel(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
  ) {
    try {
      const { buffer, filename } = await this.service.exportVentasExcel(periodo, {
        fecha_inicio,
        fecha_fin,
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

  @Get('ventas/pdf')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async ventasPdf(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
  ) {
    try {
      const { buffer, filename } = await this.service.exportVentasPdf(periodo, {
        fecha_inicio,
        fecha_fin,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    } catch (e) {
      return this.responderErrorExport(res, e, 'No se pudo exportar el PDF');
    }
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
