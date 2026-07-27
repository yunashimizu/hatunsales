import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ProductoBussnies } from '../../bussnies/Bussnies/producto.bussnies';
import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { ProductoResponse } from '../../models/model/producto.response';
import { JwtGuard } from '../../guards/jwt.guard';
import { OptionalJwtGuard } from '../../guards/optional-jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual, esUsuarioInterno } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Controller('producto')
export class ProductoController {

  constructor(private readonly service: ProductoBussnies) {}

  /**
   * El precio de compra es información interna: solo lo ve el personal.
   * Los visitantes de la tienda reciben el producto sin ese campo.
   */
  private visiblePara(producto: ProductoResponse, usuario?: UsuarioToken): ProductoResponse {
    if (esUsuarioInterno(usuario)) return producto;

    const { precio_compra, ...publico } = producto;
    return publico as ProductoResponse;
  }

  @Get()
  @UseGuards(OptionalJwtGuard)
  async getAll(@UsuarioActual() usuario?: UsuarioToken) {
    const productos = await this.service.getAll();
    return productos.map((producto) => this.visiblePara(producto, usuario));
  }

  @Get('barcode')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  findByBarcodeQuery(@Query('codigo') codigo: string) {
    return this.service.buscarPorCodigoBarras(codigo);
  }

  @Get('barcode/:codigo')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  findByBarcode(@Param('codigo') codigo: string) {
    return this.service.buscarPorCodigoBarras(codigo);
  }

  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async getById(@Param('id') id: string, @UsuarioActual() usuario?: UsuarioToken) {
    const producto = await this.service.getById(Number(id));
    return this.visiblePara(producto, usuario);
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  create(@Body() body: CrearProductoRequest) {
    return this.service.create(body);
  }

  @Put(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  update(@Param('id') id: string, @Body() body: ActualizarProductoRequest) {
    return this.service.update(body, Number(id));
  }

  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  delete(@Param('id') id: string) {
    return this.service.delete(Number(id));
  }
}
