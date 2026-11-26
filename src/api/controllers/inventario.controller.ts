import { Controller, Get, Post, Put, Body, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { InventarioBussnies } from '../../bussnies/Bussnies/inventario.bussnies';
import {
  ActualizarInventarioRequest,
  AjustarStockRequest,
  TransferirStockRequest,
} from '../../models/model/inventario.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Controller('inventario')
@UseGuards(JwtGuard, RolesGuard)
export class InventarioController {

  constructor(private readonly service: InventarioBussnies) {}

  @Get()
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  getAll() {
    return this.service.getAll();
  }

  /** Vista del panel: producto, almacén, sucursal, estado y valorizado. */
  @Get('detallado')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  detallado(
    @Query('texto') texto?: string,
    @Query('id_almacen') idAlmacen?: string,
    @Query('id_categoria') idCategoria?: string,
    @Query('solo_alertas') soloAlertas?: string,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
    @Query('id_producto') idProducto?: string,
  ) {
    const producto = Number(idProducto);
    return this.service.listar({
      texto,
      id_almacen: idAlmacen ? Number(idAlmacen) : undefined,
      id_categoria: idCategoria ? Number(idCategoria) : undefined,
      id_producto: Number.isInteger(producto) && producto > 0 ? producto : undefined,
      solo_alertas: soloAlertas === 'true',
      pagina: Number(pagina) || 1,
      por_pagina: Number(porPagina) || 50,
    });
  }

  @Get('resumen')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  resumen() {
    return this.service.resumen();
  }

  @Get('almacenes')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  almacenes(@UsuarioActual() usuario?: UsuarioToken) {
    // Fase 8.5: un usuario atado a locales solo ve los de sus locales.
    return this.service.almacenes(usuario);
  }

  /** Stock del producto en cada almacén, en una consulta (ficha de edición de producto). */
  @Get('stock-producto/:id_producto')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  stockPorProducto(@Param('id_producto', ParseIntPipe) idProducto: number) {
    return this.service.stockPorProducto(idProducto);
  }

  @Get('alertas')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
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

  /**
   * Fase 8.1: historial de movimientos de un producto con quién, cuándo, dónde y por qué, paginado
   * (`pagina`, `por_pagina` ≤ 100, `id_almacen` opcional). Sin sql/fase21 los campos de rastro salen en null
   * y `rastro` dice qué columnas faltan.
   */
  @Get('movimientos/producto/:id_producto')
  @Roles('admin', 'vendedor', 'caja')
  movimientosDeProducto(
    @Param('id_producto', ParseIntPipe) idProducto: number,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
    @Query('id_almacen') idAlmacen?: string,
  ) {
    return this.service.movimientosDeProducto(idProducto, {
      pagina: Number(pagina) || 1,
      por_pagina: Number(porPagina) || 30,
      id_almacen: Number(idAlmacen) || undefined,
    });
  }

  @Get('producto/:id_producto')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
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
  ajustar(@Body() body: AjustarStockRequest, @UsuarioActual() usuario?: UsuarioToken) {
    // El usuario va a la bitácora (Fase 6.3): quién ajustó.
    return this.service.ajustar(body, usuario);
  }

  @Post('transferencia')
  @Roles('admin', 'vendedor')
  transferir(@Body() body: TransferirStockRequest, @UsuarioActual() usuario?: UsuarioToken) {
    // Fase 8.1 y 8.5: quién transfiere (rastro del movimiento y regla de locales).
    return this.service.transferir(body, usuario);
  }

  @Put(':id/stock-minimo')
  @Roles('admin', 'vendedor')
  stockMinimo(@Param('id') id: string, @Body() body: { stock_minimo: number }) {
    return this.service.fijarStockMinimo(Number(id), Number(body?.stock_minimo ?? 0));
  }
}
