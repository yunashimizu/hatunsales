import { Controller, Get, Post, Put, Body, Param, Query, UseGuards } from '@nestjs/common';
import { InventarioBussnies } from '../../bussnies/Bussnies/inventario.bussnies';
import {
  ActualizarInventarioRequest,
  AjustarStockRequest,
  TransferirStockRequest,
} from '../../models/model/inventario.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('inventario')
@UseGuards(JwtGuard, RolesGuard)
export class InventarioController {

  constructor(private readonly service: InventarioBussnies) {}

  @Get()
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  /** Vista del panel: producto, almacén, sucursal, estado y valorizado. */
  @Get('detallado')
  @Roles('admin', 'vendedor', 'caja')
  detallado(
    @Query('texto') texto?: string,
    @Query('id_almacen') idAlmacen?: string,
    @Query('id_categoria') idCategoria?: string,
    @Query('solo_alertas') soloAlertas?: string,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
  ) {
    return this.service.listar({
      texto,
      id_almacen: idAlmacen ? Number(idAlmacen) : undefined,
      id_categoria: idCategoria ? Number(idCategoria) : undefined,
      solo_alertas: soloAlertas === 'true',
      pagina: Number(pagina) || 1,
      por_pagina: Number(porPagina) || 50,
    });
  }

  @Get('resumen')
  @Roles('admin', 'vendedor', 'caja')
  resumen() {
    return this.service.resumen();
  }

  @Get('almacenes')
  @Roles('admin', 'vendedor', 'caja')
  almacenes() {
    return this.service.almacenes();
  }

  @Get('alertas')
  @Roles('admin', 'vendedor', 'caja')
  alertas() {
    return this.service.alertas();
  }

  @Get('movimientos')
  @Roles('admin', 'vendedor', 'caja')
  movimientos(@Query('id_producto') idProducto?: string, @Query('limite') limite?: string) {
    return this.service.movimientos(
      idProducto ? Number(idProducto) : undefined,
      Number(limite) || 50,
    );
  }

  @Get('producto/:id_producto')
  @Roles('admin', 'vendedor', 'caja')
  getByProducto(@Param('id_producto') id_producto: string) {
    return this.service.getByProducto(Number(id_producto));
  }

  @Put()
  @Roles('admin', 'vendedor')
  update(@Body() body: ActualizarInventarioRequest) {
    return this.service.update(body);
  }

  /** Entrada o salida justificada, que queda registrada en el kardex. */
  @Post('ajuste')
  @Roles('admin', 'vendedor')
  ajustar(@Body() body: AjustarStockRequest) {
    return this.service.ajustar(body);
  }

  @Post('transferencia')
  @Roles('admin', 'vendedor')
  transferir(@Body() body: TransferirStockRequest) {
    return this.service.transferir(body);
  }

  @Put(':id/stock-minimo')
  @Roles('admin', 'vendedor')
  stockMinimo(@Param('id') id: string, @Body() body: { stock_minimo: number }) {
    return this.service.fijarStockMinimo(Number(id), Number(body?.stock_minimo ?? 0));
  }
}
