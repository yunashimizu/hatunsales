import {
  Body, Controller, Delete, Get, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { RecepcionBussnies } from '../../bussnies/Bussnies/recepcion.bussnies';

@ApiTags('Proveedor')
@ApiBearerAuth('access-token')
@Controller('proveedor')
@UseGuards(JwtGuard, RolesGuard)
export class ProveedorController {
  constructor(private readonly service: RecepcionBussnies) {}

  @Get()
  @Roles('admin', 'vendedor', 'caja')
  listar() {
    return this.service.listarProveedores();
  }

  @Post()
  @Roles('admin', 'vendedor')
  crear(@Body() body: any) {
    return this.service.crearProveedor(body);
  }

  @Put(':id')
  @Roles('admin', 'vendedor')
  actualizar(@Param('id') id: string, @Body() body: any) {
    return this.service.actualizarProveedor(Number(id), body);
  }

  @Delete(':id')
  @Roles('admin')
  eliminar(@Param('id') id: string) {
    return this.service.eliminarProveedor(Number(id));
  }
}
