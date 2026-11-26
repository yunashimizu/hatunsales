import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { IdEnteroPipe } from '../../util/http/pipes/id-entero.pipe';
import { LocalesUsuarioService } from '../../stock/locales-usuario.service';

/**
 * Fase 8.5 (D7): locales asignados a cada usuario (solo admin). Un usuario sin locales conserva el
 * comportamiento de hoy; con locales, solo vende, transfiere (desde) y ajusta en los almacenes de esos locales.
 */
@Controller('admin/usuarios')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class UsuarioLocalesController {
  constructor(private readonly locales: LocalesUsuarioService) {}

  /** Todas las asignaciones, para la lista de Usuarios: `{ disponible, asignaciones: [{ id_usuario, id_sucursal, nombre }] }`. */
  @Get('locales')
  todas() {
    return this.locales.todas();
  }

  /** `{ id_usuario, disponible, aplica, locales: [{ id_sucursal, nombre }] }`. */
  @Get(':id/locales')
  localesDe(@Param('id', IdEnteroPipe) id: number) {
    return this.locales.localesDe(id);
  }

  /** Cuerpo `{ id_sucursales: number[] }` (reemplaza; `[]` quita la restricción). Responde como el GET. */
  @Put(':id/locales')
  guardar(@Param('id', IdEnteroPipe) id: number, @Body() body: { id_sucursales?: unknown }, @UsuarioActual() admin: UsuarioToken) {
    return this.locales.guardar(id, body?.id_sucursales, admin);
  }
}
