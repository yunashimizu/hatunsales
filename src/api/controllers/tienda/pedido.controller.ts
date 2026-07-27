import { Body, Controller, Get, Headers, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PedidoBussnies } from '../../../bussnies/Bussnies/tienda/pedido.bussnies';
import { PagoBussnies } from '../../../bussnies/Bussnies/tienda/pago.bussnies';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { JwtGuard } from '../../../guards/jwt.guard';
import { RolesGuard } from '../../../guards/roles.guard';
import { Roles } from '../../../guards/roles.decorator';
import { UsuarioActual } from '../../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../../guards/usuario-actual.decorator';
import { CambiarEstadoPedidoRequest, CrearPedidoRequest, RegistrarPagoRequest } from '../../../models/model/tienda/pedido.request';

/** Pedidos web del cliente autenticado. */
@Controller('tienda/pedidos')
@UseGuards(JwtGuard)
export class PedidoController {

  constructor(
    private readonly service: PedidoBussnies,
    private readonly pagos: PagoBussnies,
    private readonly cuenta: CuentaTiendaBussnies,
  ) {}

  @Post()
  async crear(
    @Body() body: CrearPedidoRequest,
    @UsuarioActual() usuario: UsuarioToken,
    @Headers('idempotency-key') claveCabecera?: string,
  ) {
    const idCliente = await this.cuenta.resolverCliente(usuario);

    // La clave viaja por cabecera (estándar) o en el cuerpo, lo que llegue.
    return this.service.crearDesdeCarrito(idCliente, {
      ...body,
      clave_idempotencia: body.clave_idempotencia ?? claveCabecera,
    });
  }

  @Get()
  async misPedidos(@UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.listarMisPedidos(idCliente);
  }

  @Get('codigo/:codigo')
  async porCodigo(@Param('codigo') codigo: string, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.obtenerPorCodigo(codigo, idCliente);
  }

  @Get(':id')
  async detalle(@Param('id') id: string, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.obtener(Number(id), idCliente);
  }

  @Put(':id/cancelar')
  async cancelar(
    @Param('id') id: string,
    @Body() body: { motivo?: string },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.cancelar(Number(id), idCliente, body?.motivo);
  }

  @Post(':id/pagar')
  async pagar(
    @Param('id') id: string,
    @Body() body: RegistrarPagoRequest,
    @UsuarioActual() usuario: UsuarioToken,
    @Headers('idempotency-key') claveCabecera?: string,
  ) {
    const idCliente = await this.cuenta.resolverCliente(usuario);

    return this.pagos.pagar(
      Number(id),
      { ...body, clave_idempotencia: body?.clave_idempotencia ?? claveCabecera },
      idCliente,
    );
  }
}

/** Gestión de pedidos web desde el panel administrativo. */
@Controller('admin/pedidos')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class PedidoAdminController {

  constructor(
    private readonly service: PedidoBussnies,
    private readonly pagos: PagoBussnies,
  ) {}

  @Get()
  listar(@Query('estado') estado?: string) {
    return this.service.listarTodos(estado);
  }

  @Get(':id')
  detalle(@Param('id') id: string) {
    return this.service.obtener(Number(id));
  }

  @Put(':id/estado')
  cambiarEstado(@Param('id') id: string, @Body() body: CambiarEstadoPedidoRequest) {
    return this.service.cambiarEstado(Number(id), body.estado, body.comentario);
  }

  /** Confirma un pago hecho por fuera de la pasarela (transferencia, Yape). */
  @Put(':id/confirmar-pago')
  confirmarPago(@Param('id') id: string, @Body() body: { referencia?: string }) {
    return this.pagos.confirmarManual(Number(id), body?.referencia);
  }
}
