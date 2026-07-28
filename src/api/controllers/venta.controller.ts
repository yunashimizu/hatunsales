import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { VentaBussnies } from '../../bussnies/Bussnies/venta.bussnies';
import { CrearVentaRequest } from '../../models/model/venta/venta.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Controller('venta')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class VentaController {

  constructor(private readonly service: VentaBussnies) {}

  /** Autocompletado de productos del punto de venta. */
  @Get('productos')
  buscarProductos(@Query('q') q: string, @Query('limite') limite?: string) {
    return this.service.buscarProductos(q ?? '', Number(limite) || 12);
  }

  @Get('productos/barcode/:codigo')
  porCodigoBarras(@Param('codigo') codigo: string) {
    return this.service.buscarPorCodigoBarras(codigo);
  }

  @Get('metodos-pago')
  metodosPago() {
    return this.service.metodosPago();
  }

  /** Devuelve el comprobante calculado sin registrar la venta. */
  @Post('preview')
  preview(@Body() body: CrearVentaRequest) {
    return this.service.previsualizar(body);
  }

  @Post()
  registrar(@Body() body: CrearVentaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.registrar(body, usuario);
  }

  @Get()
  listar(
    @Query('texto') texto?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('origen') origen?: string,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
  ) {
    return this.service.listar({
      texto,
      desde,
      hasta,
      origen,
      pagina: Number(pagina) || 1,
      por_pagina: Number(porPagina) || 20,
    });
  }

  @Get(':id')
  obtener(@Param('id') id: string) {
    return this.service.obtener(Number(id));
  }

  @Post(':id/anular')
  @Roles('admin')
  anular(@Param('id') id: string) {
    return this.service.anular(Number(id));
  }
}
