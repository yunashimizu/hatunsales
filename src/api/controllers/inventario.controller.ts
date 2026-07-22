import { Controller, Get, Post, Put, Body, Param, UseGuards } from '@nestjs/common';
import { InventarioBussnies } from '../../bussnies/Bussnies/inventario.bussnies';
import { ActualizarInventarioRequest } from '../../models/model/inventario.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('inventario')
export class InventarioController {

  constructor(private readonly service: InventarioBussnies) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Get('producto/:id_producto')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getByProducto(@Param('id_producto') id_producto: string) {
    return this.service.getByProducto(Number(id_producto));
  }

  @Put()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  update(@Body() body: ActualizarInventarioRequest) {
    return this.service.update(body);
  }
}
