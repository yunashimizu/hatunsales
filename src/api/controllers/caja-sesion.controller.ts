import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CajaSesionBussnies } from '../../bussnies/Bussnies/caja-sesion.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

/**
 * Sesión de turno de caja (abrir / cerrar).
 * Comparte prefijo `/caja` con pasarela/Yape sin pisar esas rutas.
 */
@Controller('caja')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class CajaSesionController {
  constructor(private readonly service: CajaSesionBussnies) {}

  @Get('sesion')
  sesion(@UsuarioActual() usuario: UsuarioToken) {
    return this.service.sesion(usuario);
  }

  @Get('disponibles')
  disponibles() {
    return this.service.disponibles();
  }

  @Post('abrir')
  abrir(
    @Body() body: { id_caja?: number; monto_inicial?: number | null },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.abrir(body ?? {}, usuario);
  }

  @Post('cerrar')
  cerrar(
    @Body()
    body: {
      id_apertura?: number;
      monto_conteo?: number | null;
      observacion?: string | null;
    },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.cerrar(body ?? {}, usuario);
  }
}
