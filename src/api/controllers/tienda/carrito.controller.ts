import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CarritoBussnies, ContextoCarrito } from '../../../bussnies/Bussnies/tienda/carrito.bussnies';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { OptionalJwtGuard } from '../../../guards/optional-jwt.guard';
import { UsuarioActual } from '../../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../../guards/usuario-actual.decorator';
import {
  ActualizarItemCarritoRequest,
  AgregarItemCarritoRequest,
  FusionarCarritoRequest,
} from '../../../models/model/tienda/carrito.request';

/**
 * Carrito de la tienda. Funciona igual para visitantes anónimos (identificados
 * por `token_invitado`) y para clientes autenticados.
 */
@Controller('tienda/carrito')
@UseGuards(OptionalJwtGuard)
export class CarritoController {

  constructor(
    private readonly service: CarritoBussnies,
    private readonly cuenta: CuentaTiendaBussnies,
  ) {}

  private async contexto(usuario?: UsuarioToken, token?: string): Promise<ContextoCarrito> {
    if (usuario) {
      return { idCliente: await this.cuenta.resolverCliente(usuario) };
    }
    return { tokenInvitado: token };
  }

  @Get()
  async ver(
    @UsuarioActual() usuario?: UsuarioToken,
    @Query('token_invitado') token?: string,
  ) {
    return this.service.ver(await this.contexto(usuario, token));
  }

  @Post('items')
  async agregar(
    @Body() body: AgregarItemCarritoRequest,
    @UsuarioActual() usuario?: UsuarioToken,
  ) {
    const ctx = await this.contexto(usuario, body.token_invitado);
    return this.service.agregar(ctx, body.id_producto, body.cantidad);
  }

  @Put('items/:idItem')
  async actualizar(
    @Param('idItem') idItem: string,
    @Body() body: ActualizarItemCarritoRequest,
    @UsuarioActual() usuario?: UsuarioToken,
  ) {
    const ctx = await this.contexto(usuario, body.token_invitado);
    return this.service.actualizarCantidad(ctx, Number(idItem), body.cantidad);
  }

  @Delete('items/:idItem')
  async eliminar(
    @Param('idItem') idItem: string,
    @UsuarioActual() usuario?: UsuarioToken,
    @Query('token_invitado') token?: string,
  ) {
    const ctx = await this.contexto(usuario, token);
    return this.service.eliminar(ctx, Number(idItem));
  }

  @Delete()
  async vaciar(
    @UsuarioActual() usuario?: UsuarioToken,
    @Query('token_invitado') token?: string,
  ) {
    return this.service.vaciar(await this.contexto(usuario, token));
  }

  /** Al iniciar sesión, traslada el carrito de invitado a la cuenta del cliente. */
  @Post('fusionar')
  async fusionar(
    @Body() body: FusionarCarritoRequest,
    @UsuarioActual() usuario?: UsuarioToken,
  ) {
    if (!usuario) return this.service.ver({ tokenInvitado: body.token_invitado });

    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.fusionar(idCliente, body.token_invitado);
  }
}
