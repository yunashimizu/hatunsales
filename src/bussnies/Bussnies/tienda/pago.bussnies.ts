import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PedidoRepository } from '../../../repository/Repository/tienda/pedido.repository';
import { VentaTiendaRepository } from '../../../repository/Repository/tienda/venta-tienda.repository';
import { StockTiendaRepository } from '../../../repository/Repository/tienda/stock-tienda.repository';
import { PedidoBussnies } from './pedido.bussnies';
import { PASARELA_PAGO } from '../../../util/pasarela/pasarela.interface';
import type { PasarelaPago } from '../../../util/pasarela/pasarela.interface';
import { RegistrarPagoRequest } from '../../../models/model/tienda/pedido.request';
import { PedidoResponse } from '../../../models/model/tienda/pedido.response';
import { pasarelaConfig } from '../../../config/pasarela.config';

/**
 * Cobro del pedido web.
 *
 * Toda la conversación con el proveedor pasa por la interfaz `PasarelaPago`,
 * así que cambiar de Culqi a otro servicio no toca este archivo.
 */
@Injectable()
export class PagoBussnies {

  private readonly log = new Logger(PagoBussnies.name);

  constructor(
    private readonly repo: PedidoRepository,
    private readonly ventaRepo: VentaTiendaRepository,
    private readonly stockRepo: StockTiendaRepository,
    private readonly pedidos: PedidoBussnies,
    @Inject(PASARELA_PAGO) private readonly pasarela: PasarelaPago,
  ) {}

  /** Datos que el frontend necesita para montar el formulario de pago. */
  configuracionPublica() {
    return {
      proveedor: this.pasarela.nombre,
      llave_publica: this.pasarela.llavePublica(),
      moneda: pasarelaConfig.moneda,
      requiere_token: this.pasarela.nombre !== 'simulada',
    };
  }

  /**
   * Cobra un pedido. Es idempotente por partida doble: si llega la misma clave
   * o la misma referencia de la pasarela, se devuelve el resultado anterior en
   * lugar de cobrar de nuevo.
   */
  async pagar(idPedido: number, dto: RegistrarPagoRequest, idCliente?: number): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (idCliente !== undefined && pedido.cliente?.id_cliente !== idCliente) {
      throw new NotFoundException(`Pedido ${idPedido} no encontrado`);
    }

    if (pedido.estado === 'cancelado') {
      throw new BadRequestException('Este pedido fue cancelado y ya no se puede pagar');
    }

    if (pedido.estado !== 'pendiente') {
      // Ya estaba pagado: no cobramos otra vez, solo devolvemos el estado.
      return this.pedidos.obtener(idPedido);
    }

    const clave = dto.clave_idempotencia ?? `pago-${idPedido}`;
    const yaRegistrado = await this.repo.buscarPagoPorClave(idPedido, clave);

    if (yaRegistrado) {
      this.log.log(`Reintento de pago del pedido ${idPedido}; no se vuelve a cobrar`);
      return this.pedidos.obtener(idPedido);
    }

    const monto = Number(pedido.total ?? 0);

    // Los métodos sin pasarela (transferencia, contra entrega) quedan
    // pendientes de confirmación manual por parte del administrador.
    if (!dto.token_pasarela && this.pasarela.nombre !== 'simulada') {
      await this.repo.registrarPago({
        idPedido,
        idMetodo: dto.id_metodo ?? pedido.metodo_pago?.id_metodo,
        monto,
        estado: 'pendiente',
        proveedor: this.pasarela.nombre,
        clave_idempotencia: clave,
        moneda: pasarelaConfig.moneda,
        referencia: dto.referencia,
        mensaje: 'A la espera de confirmación del pago',
      });

      return this.pedidos.obtener(idPedido);
    }

    const resultado = await this.pasarela.crearCargo({
      monto,
      moneda: pasarelaConfig.moneda,
      descripcion: `Pedido ${pedido.codigo}`,
      email: dto.email ?? pedido.cliente?.email ?? 'sin-correo@hatunsales.pe',
      token: dto.token_pasarela ?? 'simulado',
      claveIdempotencia: clave,
      metadata: { id_pedido: idPedido, codigo: pedido.codigo },
    });

    await this.repo.registrarPago({
      idPedido,
      idMetodo: dto.id_metodo ?? pedido.metodo_pago?.id_metodo,
      monto,
      estado: resultado.aprobado ? 'aprobado' : 'rechazado',
      proveedor: resultado.proveedor,
      referencia: dto.referencia ?? resultado.referencia,
      referencia_externa: resultado.referencia || undefined,
      clave_idempotencia: clave,
      moneda: pasarelaConfig.moneda,
      mensaje: resultado.mensaje,
      respuesta: resultado.crudo,
    });

    if (!resultado.aprobado) {
      throw new BadRequestException(resultado.mensaje || 'El pago fue rechazado');
    }

    await this.confirmar(idPedido);
    return this.pedidos.obtener(idPedido);
  }

  /**
   * Confirmación del pago desde el webhook de la pasarela.
   * Se ejecuta sin sesión del cliente, por eso valida contra la referencia.
   */
  async procesarWebhook(cuerpo: any, cabeceras: Record<string, any>): Promise<{ recibido: boolean }> {
    const evento = this.pasarela.interpretarWebhook(cuerpo, cabeceras);

    await this.repo.registrarEventoPasarela({
      proveedor: this.pasarela.nombre,
      tipo: evento.tipo,
      referencia: evento.referencia,
      id_pedido: Number(evento.metadata?.id_pedido) || undefined,
      payload: evento.crudo,
      procesado: false,
      error: evento.valido ? undefined : 'Firma inválida',
    });

    if (!evento.valido) {
      this.log.warn(`Webhook con firma inválida (${evento.tipo})`);
      return { recibido: true };
    }

    const idPedido = Number(evento.metadata?.id_pedido);
    if (!idPedido || !evento.aprobado) return { recibido: true };

    // La pasarela reintenta hasta recibir un 200; si ya registramos ese cargo
    // no volvemos a tocar el pedido.
    if (evento.referencia) {
      const existente = await this.repo.buscarPagoPorReferenciaExterna(this.pasarela.nombre, evento.referencia);
      if (existente) return { recibido: true };
    }

    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) return { recibido: true };

    await this.repo.registrarPago({
      idPedido,
      idMetodo: pedido.metodo_pago?.id_metodo,
      monto: evento.monto ?? Number(pedido.total ?? 0),
      estado: 'aprobado',
      proveedor: this.pasarela.nombre,
      referencia_externa: evento.referencia,
      moneda: pasarelaConfig.moneda,
      mensaje: 'Confirmado por la pasarela',
      respuesta: evento.crudo,
    });

    await this.confirmar(idPedido);
    await this.repo.marcarEventoProcesado(this.pasarela.nombre, evento.referencia);

    return { recibido: true };
  }

  /** Confirmación manual desde el panel (transferencia, Yape con constancia). */
  async confirmarManual(idPedido: number, referencia?: string): Promise<PedidoResponse> {
    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) throw new NotFoundException(`Pedido ${idPedido} no encontrado`);

    if (pedido.estado === 'cancelado') {
      throw new BadRequestException('Este pedido fue cancelado');
    }

    if (pedido.estado === 'pendiente') {
      await this.repo.registrarPago({
        idPedido,
        idMetodo: pedido.metodo_pago?.id_metodo,
        monto: Number(pedido.total ?? 0),
        estado: 'aprobado',
        proveedor: 'manual',
        referencia,
        moneda: pasarelaConfig.moneda,
        mensaje: 'Confirmado manualmente por el administrador',
      });

      await this.confirmar(idPedido);
    }

    return this.pedidos.obtener(idPedido);
  }

  /** Marca el pedido como pagado y, si corresponde, genera la venta. */
  private async confirmar(idPedido: number): Promise<void> {
    await this.repo.cambiarEstado(idPedido, 'pagado');
    await this.repo.registrarEstado(idPedido, 'pagado', 'Pago confirmado');

    const cuando = (await this.stockRepo.configuracion('tienda_generar_venta')) ?? 'pagado';
    if (cuando !== 'pagado') return;

    try {
      await this.ventaRepo.generarDesdePedido(idPedido);
    } catch (error: any) {
      // El cliente ya pagó; no le devolvemos un error por un problema contable.
      this.log.error(`No se pudo generar la venta del pedido ${idPedido}: ${error?.message}`);
    }
  }
}
