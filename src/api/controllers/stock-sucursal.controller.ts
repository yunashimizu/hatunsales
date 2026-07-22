import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { StockSucursalBussnies } from '../../bussnies/Bussnies/stock-sucursal.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('stock')
export class StockSucursalController {
  constructor(private readonly service: StockSucursalBussnies) {}

  @Get('producto/:id_producto/sucursal/:id_sucursal')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getStock(@Param('id_producto') id_producto: string, @Param('id_sucursal') id_sucursal: string) {
    return this.service.obtenerStockProductoEnSucursal(Number(id_producto), Number(id_sucursal));
  }

  @Get('filtro')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  filteredList(
    @Query('id_producto') id_producto?: string,
    @Query('id_sucursal') id_sucursal?: string,
  ) {
    return this.service.listarStockFiltrado(id_producto ? Number(id_producto) : undefined, id_sucursal ? Number(id_sucursal) : undefined);
  }

  @Put('producto/:id_producto/sucursal/:id_sucursal')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  updateStock(@Param('id_producto') id_producto: string, @Param('id_sucursal') id_sucursal: string, @Body('stock') stock: number) {
    return this.service.actualizarStock(Number(id_producto), Number(id_sucursal), Number(stock));
  }

  @Post('transfer')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  transfer(@Body() body: { id_producto: number; from_sucursal: number; to_sucursal: number; cantidad: number }) {
    return this.service.transferirStock(body.id_producto, body.from_sucursal, body.to_sucursal, body.cantidad);
  }

  @Get('bajo-stock')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  lowStock(@Query('threshold') threshold = '10') {
    return this.service.listarBajoStock(Number(threshold));
  }

  @Get('alertas-stock-minimo')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  stockMinAlerts() {
    return this.service.listarAlertasStockMinimo();
  }

  @Get('movimientos')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  movimientos(
    @Query('id_producto') id_producto?: string,
    @Query('id_sucursal') id_sucursal?: string,
  ) {
    return this.service.listarMovimientos(id_producto ? Number(id_producto) : undefined, id_sucursal ? Number(id_sucursal) : undefined);
  }

  @Get('resumen-sucursal')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  resumenSucursal() {
    return this.service.resumenPorSucursal();
  }
}
