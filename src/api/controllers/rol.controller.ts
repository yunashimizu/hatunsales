import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { RolBussnies } from 'src/bussnies/Bussnies/rol.bussnies';
import { ActualizarRolRequest, CrearRolRequest } from 'src/models/model/rol.request';

@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@Controller('rol')
export class RolController {
  constructor(private readonly service: RolBussnies) {}

  @Get()
  listar() {
    return this.service.listar();
  }

  @Get(':id')
  obtener(@Param('id') id: string) {
    return this.service.obtener(Number(id));
  }

  @Post()
  crear(@Body() body: CrearRolRequest) {
    return this.service.crear(body);
  }

  @Put(':id')
  actualizar(@Param('id') id: string, @Body() body: ActualizarRolRequest) {
    return this.service.actualizar(Number(id), body);
  }

  @Delete(':id')
  eliminar(@Param('id') id: string) {
    return this.service.eliminar(Number(id));
  }
}
