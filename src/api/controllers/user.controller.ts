import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserService } from '../../bussnies/Bussnies/user-bussnies';
import { UserRequest } from '../../models/model/user-request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { IdEnteroPipe } from '../../util/http/pipes/id-entero.pipe';

/**
 * CRUD legacy de usuarios. Solo admin (el panel usa /admin/usuarios
 * y cae aquí como fallback). Antes estaba abierto sin JWT.
 */
@ApiTags('Usuario')
@ApiBearerAuth('access-token')
@Controller('usuario')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class UserController {

  constructor(private readonly service: UserService) {}

  @Get()
  getAll() {
    return this.service.getAll();
  }

  @Get(':id')
  getById(@Param('id', IdEnteroPipe) id: number) {
    return this.service.getById(id);
  }

  @Post()
  create(@Body() body: UserRequest) {
    return this.service.create(body);
  }

  @Put(':id')
  update(@Param('id', IdEnteroPipe) id: number, @Body() body: UserRequest) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  delete(@Param('id', IdEnteroPipe) id: number) {
    return this.service.delete(id);
  }
}
