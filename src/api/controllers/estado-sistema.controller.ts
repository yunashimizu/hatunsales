import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { EstadoSistemaService } from '../../estado-sistema/estado-sistema.service';

/**
 * Fase 8.6: «Estado del sistema» (solo admin). Aparte de `/salud`, que es pública y no muestra detalles internos.
 */
@Controller('sistema')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class EstadoSistemaController {
  constructor(private readonly estado: EstadoSistemaService) {}

  @Get('estado')
  @Header('Cache-Control', 'no-store')
  leer() {
    return this.estado.estado();
  }
}
