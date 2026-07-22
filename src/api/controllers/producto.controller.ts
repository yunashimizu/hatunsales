import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ProductoBussnies } from '../../bussnies/Bussnies/producto.bussnies';
import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('producto')
export class ProductoController {

  constructor(private readonly service: ProductoBussnies) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Get(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getById(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }

  @Get('barcode/:codigo')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  findByBarcode(@Param('codigo') codigo: string) {
    return this.service.buscarPorCodigoBarras(codigo);
  }

  @Get('barcode')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  findByBarcodeQuery(@Query('codigo') codigo: string) {
    return this.service.buscarPorCodigoBarras(codigo);
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
