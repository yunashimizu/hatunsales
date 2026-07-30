import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { PedidoRepository } from '../../../repository/Repository/tienda/pedido.repository';
import { CarritoRepository } from '../../../repository/Repository/tienda/carrito.repository';
import { StockTiendaRepository } from '../../../repository/Repository/tienda/stock-tienda.repository';
import { CarritoBussnies, ContextoCarrito } from './carrito.bussnies';
import { CheckoutBussnies } from './checkout.bussnies';
import { CrearPedidoRequest } from '../../../models/model/tienda/pedido.request';
import { PedidoResponse } from '../../../models/model/tienda/pedido.response';
import { Pedido } from '../../../models/DBModel/tienda/pedido.entity';
import { Cliente } from '../../../models/DBModel/cliente.entity';
import { DireccionEnvio } from '../../../models/DBModel/tienda/direccion-envio.entity';
import { MetodoEnvio } from '../../../models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';

/** Orden en que avanza un pedido; se usa para validar transiciones. */
const FLUJO_ESTADOS = ['pendiente', 'pagado', 'preparando', 'enviado', 'entregado'];

@Injectable()
export class PedidoBussnies {

  private readonly log = new Logger(PedidoBussnies.name);

  constructor(
    private readonly repo: PedidoRepository,
    private readonly carritoRepo: CarritoRepository,
    private readonly carritoBussnies: CarritoBussnies,
    private readonly checkoutBussnies: CheckoutBussnies,
    private readonly stockRepo: StockTiendaRepository,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async crearDesdeCarrito(idCliente: number, dto: CrearPedidoRequest): Promise<PedidoResponse> {
    // Si el navegador reintenta el mismo intento de compra (conexión lenta,
    // doble clic, recarga), devolvemos el pedido que ya se creó.
    if (dto.clave_idempotencia) {
      const previo = await this.repo.buscarPorClaveIdempotencia(idCliente, dto.clave_idempotencia);
      if (previo) {
        this.log.log(`Reintento detectado: se devuelve el pedido ${previo.codigo} sin duplicarlo`);
        return this.mapPedido(previo);
      }
    }

    const ctx: ContextoCarrito = { idCliente, tokenInvitado: dto.token_invitado };
    const carrito = await this.carritoBussnies.obtenerOCrear(ctx);
    const resumen = await this.carritoBussnies.armarRespuesta(carrito);

    if (resumen.items.length === 0) {
      throw new BadRequestException('Tu carrito está vacío');
    }

    const sinStock = resumen.items.filter((item) => item.excede_stock);
    if (sinStock.length > 0) {
      const nombres = sinStock.map((item) => item.nombre).join(', ');
      throw new BadRequestException(`No hay stock suficiente de: ${nombres}`);
    }

    const costoEnvio = await this.checkoutBussnies.costoEnvio(dto.id_metodo_envio);

    let descuento = 0;
    let cupon: Cupon | undefined;

    if (dto.cupon) {
      const aplicado = await this.checkoutBussnies.validarCupon(dto.cupon, resumen.total);
      descuento = aplicado.descuento;
      cupon = aplicado.cupon;
    }

    const total = this.redondear(resumen.total - descuento + costoEnvio);

    let idPedido: number;

    try {
      // Fase 8: pedido + ítems + stock + cupón + vaciar carrito en UNA sola TX.
      idPedido = await this.dataSource.transaction(async (manager) => {
        const pedido = await this.repo.crear(
          {
            codigo: await this.generarCodigo(),
            clave_idempotencia: dto.clave_idempotencia,
            cliente: { id_cliente: idCliente } as Cliente,
            direccion: dto.id_direccion ? ({ id_direccion: dto.id_direccion } as DireccionEnvio) : undefined,
            metodo_envio: dto.id_metodo_envio
              ? ({ id_metodo_envio: dto.id_metodo_envio } as MetodoEnvio)
              : undefined,
            metodo_pago: dto.id_metodo_pago ? ({ id_metodo: dto.id_metodo_pago } as MetodoPago) : undefined,
            cupon: cupon ? ({ id_cupon: cupon.id_cupon } as Cupon) : undefined,
            subtotal: resumen.subtotal,
            igv: resumen.igv,
            descuento,
            costo_envio: costoEnvio,
            total,
            estado: 'pendiente',
            tipo_comprobante: dto.tipo_comprobante ?? 'boleta',
            documento_receptor: dto.documento_receptor,
            nombre_receptor: dto.nombre_receptor,
            notas: dto.notas,
            actualizado_en: new Date(),
          },
          manager,
        );

        await this.repo.guardarItems(
          resumen.items.map((item) => {
            const { subtotal, igv } = this.carritoBussnies.desagregarIgv(item.subtotal);
            return {
              pedido: { id_pedido: pedido.id_pedido } as Pedido,
              producto: { id_producto: item.id_producto } as any,
              nombre_producto: item.nombre,
              imagen_url: item.imagen ?? undefined,
              cantidad: item.cantidad,
              precio_unitario: item.precio_unitario,
              descuento: 0,
              subtotal,
              igv,
              total: item.subtotal,
            };
          }),
          manager,
        );

        await this.reservarStockEnTx(
          manager,
          pedido.id_pedido,
          resumen.items.map((item) => ({ id_producto: item.id_producto, cantidad: item.cantidad })),
        );

        await this.repo.registrarEstado(pedido.id_pedido, 'pendiente', 'Pedido recibido', manager);

        if (cupon) await this.checkoutBussnies.registrarUso(cupon.id_cupon, manager);

        await this.carritoRepo.vaciar(carrito.id_carrito, manager);
        await this.carritoRepo.marcarConvertido(carrito.id_carrito, manager);

        return pedido.id_pedido;
      });
    } catch (error: any) {
      // Dos peticiones simultáneas con la misma clave: el índice único frena a
      // la segunda y devolvemos el pedido que ganó la carrera.
      if (dto.clave_idempotencia && this.esClaveDuplicada(error)) {
        const previo = await this.repo.buscarPorClaveIdempotencia(idCliente, dto.clave_idempotencia);
        if (previo) return this.mapPedido(previo);
      }

      if (String(error?.message ?? '').startsWith('STOCK_INSUFICIENTE')) {
        throw new BadRequestException(
          'Alguien se adelantó y ya no hay stock suficiente. Revisa tu carrito e inténtalo otra vez.',
        );
      }

      if (error instanceof BadRequestException) throw error;

      this.log.error(`Checkout falló: ${error?.message}`);
      throw error;
    }

    return this.obtener(idPedido, idCliente);
  }

  /**
   * Reserva stock dentro de la TX del checkout (Fase 8).
   * Si falla, toda la TX se revierte: no queda pedido huérfano ni cupón consumido.
   */
  private async reservarStockEnTx(
    manager: EntityManager,
    idPedido: number,
    items: { id_producto: number; cantidad: number }[],
  ): Promise<void> {
    const activa = (await this.stockRepo.configuracion('tienda_reservar_stock')) ?? 'true';
    if (activa !== 'true') return;

    const politica = await this.stockRepo.politicaStock();

    const aplicadas = await this.stockRepo.reservar(
      items,
      politica.idAlmacen,
      politica.exclusivo ? 'exclusivo' : 'spillover',
      manager,
    );

    const porProducto = new Map<number, number>();
    aplicadas.forEach((a) => porProducto.set(a.id_producto, a.id_almacen));

    await this.repo.asignarAlmacenAItems(idPedido, porProducto, manager);
    await this.repo.marcarStockReservado(idPedido, true, aplicadas[0]?.id_almacen, manager);
  }

  /** Violación del índice único de la clave de idempotencia. */
  private esClaveDuplicada(error: any): boolean {
    return error?.code === '23505' || String(error?.message ?? '').includes('uq_pedidos_idempotencia');
  }

  async listarMisPedidos(idCliente: number): Promise<PedidoResponse[]> {
    const pedidos = await this.repo.listarPorCliente(idCliente);
    return pedidos.map((pedido) => this.mapPedido(pedido));
  }

  async obtener(idPedido: number, idCliente?: number): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (idCliente !== undefined && pedido.cliente?.id_cliente !== idCliente) {
      throw new ForbiddenException('Este pedido no te pertenece');
    }

    return this.mapPedido(pedido);
  }

  async obtenerPorCodigo(codigo: string, idCliente?: number): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorCodigo(codigo);
    if (!pedido) throw new NotFoundException(`Pedido ${codigo} no encontrado`);

    if (idCliente !== undefined && pedido.cliente?.id_cliente !== idCliente) {
      throw new ForbiddenException('Este pedido no te pertenece');
    }

    return this.mapPedido(pedido);
  }

  async listarTodos(estado?: string): Promise<PedidoResponse[]> {
    const pedidos = await this.repo.listarTodos(estado);
    return pedidos.map((pedido) => this.mapPedido(pedido));
  }

  async cambiarEstado(idPedido: number, estado: string, comentario?: string): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (pedido.estado === 'entregado' && estado !== 'entregado') {
      throw new BadRequestException('Un pedido entregado ya no puede cambiar de estado');
    }

    if (pedido.estado === 'cancelado') {
      throw new BadRequestException('Un pedido cancelado ya no puede cambiar de estado');
    }

    await this.repo.cambiarEstado(idPedido, estado);
    await this.repo.registrarEstado(idPedido, estado, comentario ?? this.comentarioPorEstado(estado));

    if (estado === 'cancelado') await this.liberarStock(pedido);

    return this.obtener(idPedido);
  }

  async cancelar(idPedido: number, idCliente: number, motivo?: string): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (pedido.cliente?.id_cliente !== idCliente) {
      throw new ForbiddenException('Este pedido no te pertenece');
    }

    if (!['pendiente', 'pagado'].includes(pedido.estado)) {
      throw new BadRequestException('El pedido ya salió a preparación y no se puede cancelar en línea');
    }

    await this.repo.cambiarEstado(idPedido, 'cancelado');
    await this.repo.registrarEstado(idPedido, 'cancelado', motivo ?? 'Cancelado por el cliente');
    await this.liberarStock(pedido);

    return this.obtener(idPedido, idCliente);
  }

  /** Devuelve al inventario lo que el pedido tenía apartado. */
  async liberarStock(pedido: Pedido): Promise<void> {
    if (!pedido.stock_reservado) return;

    try {
      await this.stockRepo.devolver(pedido.id_pedido);
      await this.repo.marcarStockReservado(pedido.id_pedido, false);
    } catch (error: any) {
      // No bloqueamos la cancelación por esto, pero queda registrado para que
      // el admin pueda corregir el inventario a mano.
      this.log.error(`No se pudo devolver el stock del pedido ${pedido.id_pedido}: ${error?.message}`);
    }
  }

  // -------------------------------------------------------------- privados

  private async generarCodigo(): Promise<string> {
    const hoy = new Date();
    const fecha = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}${String(hoy.getDate()).padStart(2, '0')}`;
    const correlativo = (await this.repo.contarDelDia()) + 1;
    return `PED-${fecha}-${String(correlativo).padStart(4, '0')}`;
  }

  private comentarioPorEstado(estado: string): string {
    const mensajes: Record<string, string> = {
      pendiente:  'Pedido recibido',
      pagado:     'Pago confirmado',
      preparando: 'Estamos preparando tu pedido',
      enviado:    'Tu pedido salió a reparto',
      entregado:  'Pedido entregado',
      cancelado:  'Pedido cancelado',
    };
    return mensajes[estado] ?? estado;
  }

  private mapPedido(pedido: Pedido): PedidoResponse {
    const items = (pedido.items ?? []).map((item) => ({
      id_pedido_item: item.id_pedido_item,
      id_producto: item.producto?.id_producto,
      nombre: item.nombre_producto ?? item.producto?.nombre ?? '',
      imagen: item.imagen_url ?? undefined,
      cantidad: Number(item.cantidad ?? 0),
      precio_unitario: Number(item.precio_unitario ?? 0),
      subtotal: Number(item.subtotal ?? 0),
      igv: Number(item.igv ?? 0),
      total: Number(item.total ?? 0),
    }));

    const historial = (pedido.historial ?? [])
      .map((estado) => ({
        estado: estado.estado,
        comentario: estado.comentario ?? undefined,
        fecha: estado.creado_en,
      }))
      .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());

    const direccion = pedido.direccion;
    const direccionTexto = direccion
      ? [direccion.direccion, direccion.distrito, direccion.provincia, direccion.departamento]
          .filter(Boolean)
          .join(', ')
      : undefined;

    return {
      id_pedido: pedido.id_pedido,
      codigo: pedido.codigo,
      estado: pedido.estado,
      subtotal: Number(pedido.subtotal ?? 0),
      igv: Number(pedido.igv ?? 0),
      descuento: Number(pedido.descuento ?? 0),
      costo_envio: Number(pedido.costo_envio ?? 0),
      total: Number(pedido.total ?? 0),
      tipo_comprobante: pedido.tipo_comprobante ?? undefined,
      documento_receptor: pedido.documento_receptor ?? undefined,
      nombre_receptor: pedido.nombre_receptor ?? undefined,
      notas: pedido.notas ?? undefined,
      metodo_envio: pedido.metodo_envio?.nombre ?? undefined,
      metodo_pago: pedido.metodo_pago?.nombre ?? undefined,
      direccion_envio: direccionTexto,
      cantidad_items: items.reduce((suma, item) => suma + item.cantidad, 0),
      items,
      historial,
      creado_en: pedido.creado_en,
    };
  }

  private redondear(valor: number): number {
    return Math.round((valor + Number.EPSILON) * 100) / 100;
  }
}

export { FLUJO_ESTADOS };
