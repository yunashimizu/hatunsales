import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { CajaSesionBussnies } from '../../bussnies/Bussnies/caja-sesion.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CajaTurnosBussnies } from '../../bussnies/Bussnies/caja-turnos.bussnies';
import {
  AbrirCajaRequest,
  ActualizarCajaRequest,
  AperturasCajaQuery,
  CerrarCajaRequest,
  CrearCajaRequest,
  ResumenSucursalesPdfQuery,
  ResumenSucursalesQuery,
} from '../../models/model/caja.request';

/**
 * Sesión de turno de caja (abrir / cerrar).
 * Comparte prefijo `/caja` con pasarela/Yape y arqueo sin pisar esas rutas.
 */
@Controller('caja')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class CajaSesionController {
  constructor(
    private readonly service: CajaSesionBussnies,
    private readonly turnos: CajaTurnosBussnies,
  ) {}

  @Get('sesion')
  sesion(@UsuarioActual() usuario: UsuarioToken) {
    return this.service.sesion(usuario);
  }

  @Get('disponibles')
  disponibles(@UsuarioActual() usuario: UsuarioToken) {
    return this.service.disponibles(usuario);
  }

  /** Crea una caja en un local (solo admin: el `@Roles` del método sustituye al del controlador). */
  @Post('cajas')
  @Roles('admin')
  crearCaja(@Body() body: CrearCajaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.crearCaja(body, usuario);
  }

  /** Renombra o (des)activa una caja (solo admin). */
  @Patch('cajas/:id')
  @Roles('admin')
  actualizarCaja(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ActualizarCajaRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.actualizarCaja(id, body, usuario);
  }

  /**
   * Turnos paginados con filtros (arqueo por sucursal). Rutas de parámetros fijos: declararlas
   * antes de cualquier `caja/:id` para que no las tape.
   */
  @Get('aperturas')
  aperturas(@Query() query: AperturasCajaQuery, @UsuarioActual() usuario: UsuarioToken) {
    return this.turnos.aperturas(usuario, query);
  }

  /** Efectivo inicial, ventas por medio, esperado, contado y diferencia por sucursal. */
  @Get('resumen-sucursales')
  resumenSucursales(@Query() query: ResumenSucursalesQuery, @UsuarioActual() usuario: UsuarioToken) {
    return this.turnos.resumenSucursales(usuario, query);
  }

  /** PDF del resumen por sucursal; `id_sucursal` lo limita a una sola. Va antes de cualquier ruta con parámetro. */
  @Get('resumen-sucursales/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async resumenSucursalesPdf(
    @Query() query: ResumenSucursalesPdfQuery,
    @UsuarioActual() usuario: UsuarioToken,
  ): Promise<StreamableFile> {
    const { buffer, nombreArchivo } = await this.turnos.resumenSucursalesPdf(usuario, query);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${nombreArchivo}"`,
      length: buffer.length,
    });
  }

  @Get('turno-resumen')
  resumenTurno(@UsuarioActual() usuario: UsuarioToken) {
    return this.service.resumenTurno(usuario);
  }

  @Post('abrir')
  abrir(@Body() body: AbrirCajaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.abrir(body, usuario);
  }

  @Post('cerrar')
  cerrar(@Body() body: CerrarCajaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.cerrar(body ?? {}, usuario);
  }
}
