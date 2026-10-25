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
import { IdEnteroPipe } from '../../../util/http/pipes/id-entero.pipe';

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
  async detalle(@Param('id', IdEnteroPipe) id: number, @UsuarioActual() usuario: UsuarioToken) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.obtener(id, idCliente);
  }

  /** Solo pedidos pendientes de pago; uno pagado se gestiona con la tienda. */
  @Put(':id/cancelar')
  async cancelar(
    @Param('id', IdEnteroPipe) id: number,
    @Body() body: { motivo?: string },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    const idCliente = await this.cuenta.resolverCliente(usuario);
    return this.service.cancelar(id, idCliente, body?.motivo);
  }

  /** Sin token de tarjeta el pago queda pendiente de confirmación manual. */
  @Post(':id/pagar')
  async pagar(
    @Param('id', IdEnteroPipe) id: number,
    @Body() body: RegistrarPagoRequest,
    @UsuarioActual() usuario: UsuarioToken,
    @Headers('idempotency-key') claveCabecera?: string,
  ) {
    const idCliente = await this.cuenta.resolverCliente(usuario);

    return this.pagos.pagar(
      id,
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
  detalle(@Param('id', IdEnteroPipe) id: number) {
    return this.service.obtener(id);
  }

  @Put(':id/estado')
  cambiarEstado(@Param('id', IdEnteroPipe) id: number, @Body() body: CambiarEstadoPedidoRequest) {
    return this.service.cambiarEstado(id, body.estado, body.comentario);
  }

  /** Confirma un pago hecho por fuera de la pasarela (transferencia, Yape, contra entrega). */
  @Put(':id/confirmar-pago')
  confirmarPago(@Param('id', IdEnteroPipe) id: number, @Body() body: { referencia?: string }) {
    const referencia = typeof body?.referencia === 'string' ? body.referencia.trim().slice(0, 120) : undefined;
    return this.pagos.confirmarManual(id, referencia || undefined);
  }
}
