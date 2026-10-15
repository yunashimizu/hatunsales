import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LogBussnies } from '../../bussnies/Bussnies/log.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

/** Últimas 500 acciones del CRUD antiguo de usuarios: [{ idlog, accion, entidad, fecha }]. */
@ApiTags('Log')
@ApiBearerAuth('access-token')
@Controller('log')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class LogController {

  constructor(private readonly logBussnies: LogBussnies) {}

  @Get()
  getAll() {
    return this.logBussnies.listar();
  }
}
