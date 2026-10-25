import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PedidoRepository } from '../../../repository/Repository/tienda/pedido.repository';
import { CarritoRepository } from '../../../repository/Repository/tienda/carrito.repository';
import { CuentaTiendaRepository } from '../../../repository/Repository/tienda/cuenta.repository';
import { ReservaAplicada, StockTiendaRepository } from '../../../repository/Repository/tienda/stock-tienda.repository';
import { CarritoBussnies, CarritoItemTienda } from './carrito.bussnies';
import { CheckoutBussnies } from './checkout.bussnies';
import { CrearPedidoRequest } from '../../../models/model/tienda/pedido.request';
import { PedidoItemResponse, PedidoResponse } from '../../../models/model/tienda/pedido.response';
import { Pedido } from '../../../models/DBModel/tienda/pedido.entity';
import { PedidoItem } from '../../../models/DBModel/tienda/pedido-item.entity';
import { Producto } from '../../../models/DBModel/producto.entity';
import { Cliente } from '../../../models/DBModel/cliente.entity';
import { DireccionEnvio } from '../../../models/DBModel/tienda/direccion-envio.entity';
import { MetodoEnvio } from '../../../models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';
import { hoyLima } from '../../../util/fecha-lima';

/** Orden en que avanza un pedido; se usa para validar transiciones. */
const FLUJO_ESTADOS = ['pendiente', 'pagado', 'preparando', 'enviado', 'entregado'];

/** En línea, el cliente solo cancela lo que todavía no se cobró. */
const CANCELABLE_POR_CLIENTE = ['pendiente'];

/** Largo de `pedido_estados.comentario`. */
const LARGO_COMENTARIO = 255;

/** Código provisional, único, que solo existe dentro de la transacción del checkout. */
function codigoProvisional(): string {
  return `TMP-${randomUUID().replace(/-/g, '').slice(0, 26)}`;
}

/**
 * PED-AAAAMMDD-NNNN con la fecha de Lima y el id del pedido. Antes era el
 * COUNT(*) del día + 1 (dos checkouts a la vez chocaban en `pedidos_codigo_key`)
 * con la fecha UTC (los pedidos de la noche salían con la fecha de mañana).
 */
export function codigoPedido(idPedido: number, hoy: string = hoyLima()): string {
  return `PED-${hoy.replace(/-/g, '')}-${String(idPedido).padStart(4, '0')}`;
}

function recortar(texto: unknown, largo = LARGO_COMENTARIO): string | undefined {
  const limpio = typeof texto === 'string' ? texto.trim() : '';
  return limpio ? limpio.slice(0, largo) : undefined;
}

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
    private readonly cuentaRepo: CuentaTiendaRepository,
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

    // La dirección viaja en la respuesta del pedido: tiene que ser del cliente
    // (antes cualquier id servía y dejaba ver direcciones de otras cuentas).
    if (dto.id_direccion && !(await this.cuentaRepo.obtenerDireccion(dto.id_direccion, idCliente))) {
      throw new BadRequestException('La dirección de envío no pertenece a tu cuenta. Elige una de tus direcciones.');
    }

    const carrito = await this.carritoBussnies.buscar({ idCliente, tokenInvitado: dto.token_invitado });
    if (!carrito) throw new BadRequestException('Tu carrito está vacío');

    const resumen = await this.carritoBussnies.armarRespuesta(carrito);
    this.validarCarrito(resumen.items);

    const costoEnvio = await this.checkoutBussnies.costoEnvio(dto.id_metodo_envio);
    if (dto.id_metodo_pago) await this.checkoutBussnies.validarMetodoPago(dto.id_metodo_pago);

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
            codigo: codigoProvisional(),
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

        await this.repo.asignarCodigo(pedido.id_pedido, codigoPedido(pedido.id_pedido), manager);

        const reservas = await this.reservarStockEnTx(manager, resumen.items);
        await this.repo.guardarItems(this.lineasDelPedido(pedido.id_pedido, resumen.items, reservas), manager);
        if (reservas) await this.repo.marcarStockReservado(pedido.id_pedido, true, reservas[0]?.id_almacen, manager);

        await this.repo.registrarEstado(pedido.id_pedido, 'pendiente', 'Pedido recibido', manager);

        if (cupon) await this.checkoutBussnies.registrarUso(cupon.id_cupon, manager);

        await this.carritoRepo.vaciar(carrito.id_carrito, manager);
        await this.carritoRepo.marcarConvertido(carrito.id_carrito, manager);

        return pedido.id_pedido;
      });
    } catch (error: any) {
      if (this.esViolacionUnica(error)) {
        // Dos peticiones simultáneas con la misma clave: el índice único frena a
        // la segunda y devolvemos el pedido que ganó la carrera.
        if (dto.clave_idempotencia && this.restriccionDe(error) === 'uq_pedidos_idempotencia') {
          const previo = await this.repo.buscarPorClaveIdempotencia(idCliente, dto.clave_idempotencia);
          if (previo) return this.mapPedido(previo);
        }
        // Cualquier otra unicidad NO es un reintento del cliente: no se le
        // devuelve un pedido ajeno a su intento ni un error genérico.
        this.log.error(`Checkout chocó con ${this.restriccionDe(error) ?? 'un índice único'}: ${error?.message}`);
        throw new ConflictException('No pudimos registrar tu pedido por un cruce con otra compra. Inténtalo de nuevo.');
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

  /**
   * Cambio de estado desde el panel. Solo avanza en el flujo, 'pagado' pasa por
   * «Confirmar pago» (registra el cobro y genera la venta) y el cambio es
   * condicional: si otro proceso movió el pedido, no se pisa.
   */
  async cambiarEstado(idPedido: number, estado: string, comentario?: string): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);
    if (pedido.estado === estado) return this.mapPedido(pedido);

    await this.validarTransicion(pedido, estado);

    const nota = recortar(comentario) ?? this.comentarioPorEstado(estado);
    const cambiado = estado === 'cancelado'
      ? await this.cancelarEnTx(idPedido, [pedido.estado], nota)
      : (await this.repo.transicionarEstado(idPedido, [pedido.estado], estado, nota)) !== null;

    if (!cambiado) {
      throw new ConflictException('El pedido cambió mientras lo actualizabas. Recarga para ver su estado actual.');
    }

    return this.obtener(idPedido);
  }

  /**
   * Cancelación en línea del cliente: solo pedidos pendientes. Un pedido pagado
   * ya tiene su venta y su cobro; cancelarlo aquí devolvía el stock pero dejaba
   * la venta activa y el dinero sin devolver.
   */
  async cancelar(idPedido: number, idCliente: number, motivo?: string): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (pedido.cliente?.id_cliente !== idCliente) {
      throw new ForbiddenException('Este pedido no te pertenece');
    }

    if (pedido.estado === 'cancelado') return this.mapPedido(pedido);
    this.exigirCancelablePorCliente(pedido.estado);

    const cancelado = await this.cancelarEnTx(
      idPedido,
      CANCELABLE_POR_CLIENTE,
      recortar(motivo) ?? 'Cancelado por el cliente',
    );

    if (!cancelado) {
      // Se cruzó con la confirmación del pago (o con otra cancelación).
      const actual = await this.repo.obtenerPorId(idPedido);
      if (actual?.estado !== 'cancelado') this.exigirCancelablePorCliente(actual?.estado ?? 'pagado');
    }

    return this.obtener(idPedido, idCliente);
  }

  // -------------------------------------------------------------- privados

  /** Lo que impide convertir el carrito en pedido, con un mensaje que el cliente pueda resolver. */
  private validarCarrito(items: CarritoItemTienda[]): void {
    if (items.length === 0) throw new BadRequestException('Tu carrito está vacío');

    const nombres = (lista: CarritoItemTienda[]) => lista.map((item) => item.nombre).join(', ');

    const retirados = items.filter((item) => item.no_disponible);
    if (retirados.length > 0) {
      throw new BadRequestException(`Ya no vendemos: ${nombres(retirados)}. Quítalo de tu carrito para continuar.`);
    }

    const sinStock = items.filter((item) => item.excede_stock);
    if (sinStock.length > 0) {
      throw new BadRequestException(`No hay stock suficiente de: ${nombres(sinStock)}`);
    }

    // El total que el cliente vio ya no es el que se cobraría: se le avisa para
    // que confirme de nuevo (el carrito ya quedó con los precios vigentes).
    const conNuevoPrecio = items.filter((item) => item.precio_cambio);
    if (conNuevoPrecio.length > 0) {
      throw new ConflictException({
        message: `Cambió el precio de: ${nombres(conNuevoPrecio)}. Revisa el total de tu carrito y confirma de nuevo.`,
        codigo: 'PRECIOS_ACTUALIZADOS',
      });
    }
  }

  /**
   * Reserva stock dentro de la TX del checkout (Fase 8). Devuelve de qué almacén
   * salió cada tramo, o null si la tienda no reserva stock.
   * Si falla, toda la TX se revierte: no queda pedido huérfano ni cupón consumido.
   */
  private async reservarStockEnTx(
    manager: EntityManager,
    items: CarritoItemTienda[],
  ): Promise<ReservaAplicada[] | null> {
    const activa = (await this.stockRepo.configuracion('tienda_reservar_stock')) ?? 'true';
    if (activa !== 'true') return null;

    const politica = await this.stockRepo.politicaStock();

    return this.stockRepo.reservar(
      items.map((item) => ({ id_producto: item.id_producto, cantidad: item.cantidad })),
      politica.idAlmacen,
      politica.exclusivo ? 'exclusivo' : 'spillover',
      manager,
    );
  }

  /**
   * Una línea por producto y almacén. En modo spillover una línea del carrito
   * puede salir de dos almacenes: cada tramo se guarda con su almacén para que
   * la cancelación devuelva a cada uno lo que salió de él (antes quedaba un
   * solo almacén por línea y se le devolvía todo).
   */
  private lineasDelPedido(
    idPedido: number,
    items: CarritoItemTienda[],
    reservas: ReservaAplicada[] | null,
  ): Partial<PedidoItem>[] {
    return items.flatMap((item) => {
      const tramos = reservas?.filter((reserva) => reserva.id_producto === item.id_producto) ?? [];
      const partes: { cantidad: number; id_almacen?: number }[] = tramos.length > 0
        ? tramos
        : [{ cantidad: item.cantidad }];

      return partes.map((parte) => {
        const totalLinea = this.redondear(item.precio_unitario * parte.cantidad);
        const { subtotal, igv } = this.carritoBussnies.desagregarIgv(totalLinea);
        return {
          pedido: { id_pedido: idPedido } as Pedido,
          producto: { id_producto: item.id_producto } as Producto,
          nombre_producto: item.nombre,
          imagen_url: item.imagen ?? undefined,
          cantidad: parte.cantidad,
          precio_unitario: item.precio_unitario,
          descuento: 0,
          subtotal,
          igv,
          total: totalLinea,
          id_almacen: parte.id_almacen,
        };
      });
    });
  }

  /**
   * Cancela y devuelve el stock en la MISMA transacción, solo si el pedido sigue
   * en `desde` y no tiene una venta vigente. La devolución se decide con lo que
   * quedó en la fila bloqueada: si el pedido tiene venta, el stock salió con
   * ella (lo repone su anulación) y aquí no se vuelve a sumar.
   */
  private async cancelarEnTx(idPedido: number, desde: readonly string[], comentario: string): Promise<boolean> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const fila = await this.repo.transicionarEstado(
          idPedido, desde, 'cancelado', comentario, manager, { sinVentaVigente: true },
        );
        if (!fila) return false;

        if (fila.stock_reservado) {
          if (fila.id_venta === null) await this.stockRepo.devolver(idPedido, manager);
          await this.repo.marcarStockReservado(idPedido, false, undefined, manager);
        }
        return true;
      });
    } catch (error: any) {
      this.log.error(`No se pudo cancelar el pedido ${idPedido} ni devolver su stock: ${error?.message}`);
      throw new InternalServerErrorException('No pudimos cancelar el pedido. Inténtalo de nuevo en unos segundos.');
    }
  }

  private exigirCancelablePorCliente(estado: string): void {
    if (CANCELABLE_POR_CLIENTE.includes(estado)) return;

    if (estado === 'pagado') {
      throw new BadRequestException(
        'Tu pago ya fue confirmado. Para cancelar el pedido y gestionar la devolución, comunícate con la tienda.',
      );
    }
    throw new BadRequestException('El pedido ya salió a preparación y no se puede cancelar en línea');
  }

  /** Reglas del panel para mover un pedido; FLUJO_ESTADOS solo avanza. */
  private async validarTransicion(pedido: Pedido, destino: string): Promise<void> {
    if (pedido.estado === 'cancelado') {
      throw new BadRequestException('Un pedido cancelado ya no puede cambiar de estado');
    }
    if (pedido.estado === 'entregado') {
      throw new BadRequestException('Un pedido entregado ya no puede cambiar de estado');
    }

    if (destino === 'cancelado') {
      if (pedido.id_venta && (await this.repo.estadoVenta(pedido.id_venta)) !== 'anulada') {
        throw new BadRequestException(
          `El pedido ya tiene la venta N° ${pedido.id_venta}. Anúlala primero desde Ventas (eso devuelve el stock y, `
          + 'si hay comprobante, emite la nota de crédito); luego cancela el pedido.',
        );
      }
      return;
    }

    if (destino === 'pagado') {
      throw new BadRequestException(
        'Para marcar un pedido como pagado usa «Confirmar pago»: así queda registrado el cobro y se genera la venta.',
      );
    }

    const actual = FLUJO_ESTADOS.indexOf(pedido.estado);
    const siguiente = FLUJO_ESTADOS.indexOf(destino);
    if (siguiente < 0) throw new BadRequestException(`Estado «${destino}» no válido`);
    if (siguiente <= actual) {
      throw new BadRequestException(`Un pedido en estado «${pedido.estado}» no puede volver a «${destino}»`);
    }
  }

  /** Violación de un índice único (23505), venga de TypeORM o del driver. */
  private esViolacionUnica(error: any): boolean {
    return (error?.code ?? error?.driverError?.code) === '23505';
  }

  private restriccionDe(error: any): string | undefined {
    const nombre = error?.constraint ?? error?.driverError?.constraint;
    if (nombre) return String(nombre);
    return String(error?.message ?? '').includes('uq_pedidos_idempotencia') ? 'uq_pedidos_idempotencia' : undefined;
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

  /** Junta los tramos de un mismo producto (uno por almacén) en una sola línea para mostrar. */
  private lineasParaMostrar(items: PedidoItem[]): PedidoItemResponse[] {
    const lineas = new Map<string, PedidoItemResponse>();
    const ordenados = [...items].sort((a, b) => Number(a.id_pedido_item) - Number(b.id_pedido_item));

    for (const item of ordenados) {
      const idProducto = item.producto?.id_producto;
      const precio = Number(item.precio_unitario ?? 0);
      const clave = idProducto ? `${idProducto}|${precio}` : `linea-${item.id_pedido_item}`;
      const previa = lineas.get(clave);

      if (previa) {
        previa.cantidad += Number(item.cantidad ?? 0);
        previa.subtotal = this.redondear(previa.subtotal + Number(item.subtotal ?? 0));
        previa.igv = this.redondear(previa.igv + Number(item.igv ?? 0));
        previa.total = this.redondear(previa.total + Number(item.total ?? 0));
        continue;
      }

      lineas.set(clave, {
        id_pedido_item: item.id_pedido_item,
        id_producto: idProducto,
        nombre: item.nombre_producto ?? item.producto?.nombre ?? '',
        imagen: item.imagen_url ?? undefined,
        cantidad: Number(item.cantidad ?? 0),
        precio_unitario: precio,
        subtotal: Number(item.subtotal ?? 0),
        igv: Number(item.igv ?? 0),
        total: Number(item.total ?? 0),
      });
    }

    return [...lineas.values()];
  }

  private mapPedido(pedido: Pedido): PedidoResponse {
    const items = this.lineasParaMostrar(pedido.items ?? []);

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
