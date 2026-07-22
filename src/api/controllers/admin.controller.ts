import { Controller, Get, Post, Put, Delete, Body, UseGuards } from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { AdminBussnies } from 'src/bussnies/Bussnies/admin.bussnies';
import { CrearEmpleadoRequest } from 'src/models/model/new/crear-empleado.request';
import { CambiarRolRequest } from 'src/models/model/new/cambiar-rol.request';
import { EliminarUsuarioRequest } from 'src/models/model/new/eliminar-usuario.request';
import { ApiBearerAuth } from '@nestjs/swagger/dist/decorators/api-bearer.decorator';
import { ApiTags } from '@nestjs/swagger/dist/decorators';
import { AuthGuard } from '@nestjs/passport';

@ApiTags('Admin')
@ApiBearerAuth('access-token')   // 👈 mismo nombre del esquema
@UseGuards(AuthGuard('jwt'))      // 👈 protege todos los endpoints del controller
@Controller('admin')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class AdminController {

  constructor(private readonly adminService: AdminBussnies) {}

  @Get('usuarios')
  listarTodos() {
    return this.adminService.listarTodos();
  }

  @Post('crear-empleado')
  crearEmpleado(@Body() body: CrearEmpleadoRequest) {
    return this.adminService.crearEmpleado(body);
  }

  @Put('cambiar-rol')
  cambiarRol(@Body() body: CambiarRolRequest) {
    return this.adminService.cambiarRol(body);
  }

  @Delete('eliminar')
  eliminarUsuario(@Body() body: EliminarUsuarioRequest) {
    return this.adminService.eliminarUsuario(body);
  }

  @Put('desactivar')
  desactivarUsuario(@Body() body: EliminarUsuarioRequest) {
    return this.adminService.desactivarUsuario(body);
  }
}