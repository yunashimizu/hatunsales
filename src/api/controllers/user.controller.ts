import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserService } from '../../bussnies/Bussnies/user-bussnies';
import { UserRequest } from '../../models/model/user-request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

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
  getById(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }

  @Post()
  create(@Body() body: UserRequest) {
    return this.service.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: UserRequest) {
    return this.service.update(Number(id), body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(Number(id));
  }
}
