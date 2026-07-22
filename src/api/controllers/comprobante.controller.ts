import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ComprobanteBussnies } from '../../bussnies/Bussnies/comprobante.bussnies';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('comprobante')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class ComprobanteController {

  constructor(private readonly service: ComprobanteBussnies) {}

  @Post('generar')
  generar(@Body() body: GenerarComprobanteRequest) {
    return this.service.generar(body);
  }

  @Post('consultar')
  consultar(@Body() body: ConsultarComprobanteRequest) {
    return this.service.consultar(body);
  }

  @Post('anular')
  @Roles('admin')
  anular(@Body() body: AnularComprobanteRequest) {
    return this.service.anular(body);
  }

  @Post('consultar-anulacion')
  consultarAnulacion(@Body() body: ConsultarComprobanteRequest) {
    return this.service.consultarAnulacion(body);
  }

  @Get('venta/:id')
  listarPorVenta(@Param('id') id: string) {
    return this.service.listarPorVenta(Number(id));
  }

  @Get('cliente/:id')
  listarPorCliente(@Param('id') id: string) {
    return this.service.listarPorCliente(Number(id));
  }
}