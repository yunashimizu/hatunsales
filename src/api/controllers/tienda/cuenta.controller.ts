import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { JwtGuard } from '../../../guards/jwt.guard';
import { UsuarioActual } from '../../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../../guards/usuario-actual.decorator';
import { CrearResenaRequest, GuardarDireccionRequest } from '../../../models/model/tienda/cuenta.request';
import { IdEnteroPipe } from '../../../util/http/pipes/id-entero.pipe';

/** Cuenta del cliente en la tienda: direcciones, favoritos y reseñas. */
@Controller('tienda/cuenta')
@UseGuards(JwtGuard)
export class CuentaTiendaController {

  constructor(private readonly service: CuentaTiendaBussnies) {}

  @Get()
  async perfil(@UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.perfil(idCliente);
  }

  // ------------------------------------------------------------ direcciones

  @Get('direcciones')
  async listarDirecciones(@UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.listarDirecciones(idCliente);
  }

  @Post('direcciones')
  async crearDireccion(@Body() body: GuardarDireccionRequest, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.crearDireccion(idCliente, body);
  }

  @Put('direcciones/:id')
  async actualizarDireccion(
    @Param('id', IdEnteroPipe) id: number,
    @Body() body: GuardarDireccionRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.actualizarDireccion(idCliente, id, body);
  }

  @Delete('direcciones/:id')
  async eliminarDireccion(@Param('id', IdEnteroPipe) id: number, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.eliminarDireccion(idCliente, id);
  }

  // -------------------------------------------------------------- favoritos

  @Get('favoritos')
  async listarFavoritos(@UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.listarFavoritos(idCliente);
  }

  @Get('favoritos/ids')
  async idsFavoritos(@UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.listarIdsFavoritos(idCliente);
  }

  @Post('favoritos/:idProducto')
  async alternarFavorito(@Param('idProducto', IdEnteroPipe) idProducto: number, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.alternarFavorito(idCliente, idProducto);
  }

  // ---------------------------------------------------------------- reseñas

  @Post('resenas/:idProducto')
  async guardarResena(
    @Param('idProducto', IdEnteroPipe) idProducto: number,
    @Body() body: CrearResenaRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    const idCliente = await this.service.resolverCliente(usuario);
    return this.service.guardarResena(idCliente, idProducto, body);
  }
}
