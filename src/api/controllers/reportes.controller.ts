import { Controller, Get, Query, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReportesBussnies } from '../../bussnies/Bussnies/reportes.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

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
  ventasExcel(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
  ) {
    const buffers = this.service.exportVentasExcel(periodo, {
      fecha_inicio,
      fecha_fin,
    });
    return buffers.then((b) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=ventas_${periodo}.xlsx`);
      res.send(b);
    });
  }

  @Get('ventas/pdf')
  @UseGuards(JwtGuard, RolesGuard)
  ventasPdf(
    @Res() res: Response,
    @Query('periodo') periodo = 'diario',
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
  ) {
    const buffers = this.service.exportVentasPdf(periodo, {
      fecha_inicio,
      fecha_fin,
    });
    return buffers.then((b) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=ventas_${periodo}.pdf`);
      res.send(b);
    });
  }
}
