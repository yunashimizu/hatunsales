import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatosPago, PedidoRepository } from '../../../repository/Repository/tienda/pedido.repository';
import { VentaTiendaRepository } from '../../../repository/Repository/tienda/venta-tienda.repository';
import { StockTiendaRepository } from '../../../repository/Repository/tienda/stock-tienda.repository';
import { PedidoBussnies } from './pedido.bussnies';
import { EventoWebhook, PASARELA_PAGO } from '../../../util/pasarela/pasarela.interface';
import type { PasarelaPago } from '../../../util/pasarela/pasarela.interface';
import { RegistrarPagoRequest } from '../../../models/model/tienda/pedido.request';
import { PedidoResponse } from '../../../models/model/tienda/pedido.response';
import { pasarelaConfig } from '../../../config/pasarela.config';

/** Diferencia máxima, en céntimos, entre lo que avisa la pasarela y el total del pedido. */
const TOLERANCIA_CENTIMOS = 1;

/**
 * Cobro del pedido web.
 *
 * Toda la conversación con el proveedor pasa por la interfaz `PasarelaPago`,
 * así que cambiar de Culqi a otro servicio no toca este archivo.
 *
 * Un pedido solo pasa a 'pagado' con un cambio condicional ('pendiente' →
 * 'pagado') que va en la misma transacción que el cobro que lo respalda: un
 * pedido cancelado o ya pagado nunca se vuelve a confirmar.
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
      await this.confirmarSiPagoAprobado(idPedido, yaRegistrado.estado);
      return this.pedidos.obtener(idPedido);
    }

    const monto = Number(pedido.total ?? 0);
    const idMetodo = dto.id_metodo ?? pedido.metodo_pago?.id_metodo;

    // Sin token no hay ningún cobro que verificar (transferencia, Yape, contra
    // entrega): el pedido queda pendiente hasta que el administrador confirme el
    // pago (PUT /admin/pedidos/:id/confirmar-pago). Antes, con la pasarela
    // simulada, se aprobaba solo y se generaba la venta sin que entrara dinero.
    if (!dto.token_pasarela) {
      await this.repo.registrarPago({
        idPedido,
        idMetodo,
        monto,
        estado: 'pendiente',
        proveedor: 'manual',
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
      token: dto.token_pasarela,
      claveIdempotencia: clave,
      metadata: { id_pedido: idPedido, codigo: pedido.codigo },
    });

    const pago: DatosPago = {
      idPedido,
      idMetodo,
      monto,
      estado: resultado.aprobado ? 'aprobado' : 'rechazado',
      proveedor: resultado.proveedor,
      referencia: dto.referencia ?? resultado.referencia,
      referencia_externa: resultado.referencia || undefined,
      clave_idempotencia: clave,
      moneda: pasarelaConfig.moneda,
      mensaje: resultado.mensaje,
      respuesta: resultado.crudo,
    };

    if (!resultado.aprobado) {
      await this.repo.registrarPago(pago);
      throw new BadRequestException(resultado.mensaje || 'El pago fue rechazado');
    }

    if (await this.confirmar(idPedido, 'Pago confirmado', pago)) {
      return this.pedidos.obtener(idPedido);
    }
    return this.cargoSobrePedidoNoPendiente(idPedido, pago);
  }

  /**
   * Confirmación del pago desde el webhook de la pasarela.
   * Se ejecuta sin sesión del cliente: solo vale un evento con firma válida,
   * sobre un pedido pendiente y por el monto exacto del pedido. Lo que no se
   * aplica queda anotado en `pasarela_eventos` con el motivo.
   */
  async procesarWebhook(cuerpo: any, cabeceras: Record<string, any>): Promise<{ recibido: boolean }> {
    const evento = this.pasarela.interpretarWebhook(cuerpo, cabeceras);
    const idPedido = this.idPedidoDe(evento.metadata);

    const idEvento = await this.repo.registrarEventoPasarela({
      proveedor: this.pasarela.nombre,
      tipo: evento.tipo,
      referencia: evento.referencia,
      id_pedido: idPedido,
      payload: evento.crudo,
      procesado: false,
      error: evento.valido ? undefined : 'Firma inválida (o webhook no admitido por esta pasarela)',
    });

    if (!evento.valido) {
      this.log.warn(`Webhook con firma inválida (${evento.tipo})`);
      return { recibido: true };
    }

    if (!evento.aprobado) return { recibido: true };

    const motivo = await this.aplicarCobroDelWebhook(evento, idPedido);
    await this.repo.cerrarEventoPasarela(
      { idEvento, proveedor: this.pasarela.nombre, referencia: evento.referencia },
      motivo ? { procesado: false, error: motivo } : { procesado: true },
    );

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
      const confirmado = await this.confirmar(idPedido, 'Pago confirmado por el administrador', {
        idPedido,
        idMetodo: pedido.metodo_pago?.id_metodo,
        monto: Number(pedido.total ?? 0),
        estado: 'aprobado',
        proveedor: 'manual',
        referencia,
        moneda: pasarelaConfig.moneda,
        mensaje: 'Confirmado manualmente por el administrador',
      });

      if (!confirmado && (await this.repo.obtenerPorId(idPedido))?.estado === 'cancelado') {
        throw new BadRequestException('El pedido se canceló mientras confirmabas el pago');
      }
    }

    return this.pedidos.obtener(idPedido);
  }

  // -------------------------------------------------------------- privados

  /** Aplica el cobro que avisa la pasarela. Devuelve el motivo si no se aplicó. */
  private async aplicarCobroDelWebhook(evento: EventoWebhook, idPedido?: number): Promise<string | undefined> {
    // La pasarela reintenta hasta recibir un 200: si el cargo ya está registrado
    // solo se completa la confirmación de SU pedido, no del que diga la metadata.
    if (evento.referencia) {
      const existente = await this.repo.buscarPagoPorReferenciaExterna(this.pasarela.nombre, evento.referencia);
      if (existente) {
        await this.confirmarSiPagoAprobado(existente.pedido.id_pedido, existente.estado);
        return undefined;
      }
    }

    if (!idPedido) return 'El evento no indica a qué pedido corresponde';

    const pedido = await this.repo.obtenerPorId(idPedido);
    if (!pedido) return `El pedido ${idPedido} no existe`;

    if (pedido.estado !== 'pendiente') {
      const motivo = pedido.estado === 'cancelado'
        ? `Cobro recibido para el pedido ${pedido.codigo}, que está cancelado: revisar la devolución`
        : `El pedido ${pedido.codigo} ya estaba en estado ${pedido.estado}`;
      this.log.warn(motivo);
      return motivo;
    }

    const total = Number(pedido.total ?? 0);
    if (evento.monto !== undefined && !this.montosCoinciden(evento.monto, total)) {
      const motivo = `El monto cobrado (S/ ${evento.monto}) no coincide con el total del pedido ${pedido.codigo} (S/ ${total})`;
      this.log.warn(motivo);
      return motivo;
    }

    const confirmado = await this.confirmar(idPedido, 'Pago confirmado por la pasarela', {
      idPedido,
      idMetodo: pedido.metodo_pago?.id_metodo,
      monto: evento.monto ?? total,
      estado: 'aprobado',
      proveedor: this.pasarela.nombre,
      referencia_externa: evento.referencia,
      moneda: pasarelaConfig.moneda,
      mensaje: 'Confirmado por la pasarela',
      respuesta: evento.crudo,
    });

    return confirmado ? undefined : `El pedido ${pedido.codigo} cambió de estado antes de confirmar el pago: revisar`;
  }

  /**
   * El cargo salió, pero el pedido dejó de estar pendiente mientras se cobraba.
   * Si figura pagado (lo confirmó el webhook del mismo cargo) no hay nada que
   * hacer; si se canceló, el cobro queda registrado para poder devolverlo.
   */
  private async cargoSobrePedidoNoPendiente(idPedido: number, pago: DatosPago): Promise<PedidoResponse> {
    const actual = await this.repo.obtenerPorId(idPedido);
    if (actual && actual.estado !== 'cancelado') return this.pedidos.obtener(idPedido);

    await this.repo.registrarPago({ ...pago, mensaje: 'Cobro aprobado sobre un pedido cancelado: requiere devolución' });
    this.log.error(`Pedido ${idPedido}: cargo ${pago.referencia_externa ?? ''} aprobado con el pedido cancelado; requiere devolución`);
    throw new ConflictException(
      'Tu pago fue aprobado, pero el pedido ya estaba cancelado. Te contactaremos para devolverte el dinero.',
    );
  }

  /**
   * Si el cobro ya quedó registrado pero el pedido sigue pendiente
   * (fallo entre el cargo y la confirmación), reintenta cerrar el flujo.
   */
  private async confirmarSiPagoAprobado(idPedido: number, estadoPago?: string): Promise<void> {
    if (estadoPago !== 'aprobado') return;
    if (await this.confirmar(idPedido, 'Pago confirmado')) {
      this.log.warn(`Se completó la confirmación pendiente del pedido ${idPedido}`);
    }
  }

  /**
   * Pasa el pedido a 'pagado' (solo si sigue pendiente) junto con su cobro y,
   * si corresponde, genera la venta. Devuelve false si no hubo cambio.
   */
  private async confirmar(idPedido: number, comentario: string, pago?: DatosPago): Promise<boolean> {
    if (!(await this.repo.confirmarPago(idPedido, comentario, pago))) return false;

    const cuando = (await this.stockRepo.configuracion('tienda_generar_venta')) ?? 'pagado';
    if (cuando !== 'pagado') return true;

    try {
      await this.ventaRepo.generarDesdePedido(idPedido);
    } catch (error: any) {
      // El cliente ya pagó; no le devolvemos un error por un problema contable.
      this.log.error(`No se pudo generar la venta del pedido ${idPedido}: ${error?.message}`);
    }
    return true;
  }

  private idPedidoDe(metadata?: Record<string, any>): number | undefined {
    const id = Number(metadata?.id_pedido);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  }

  private montosCoinciden(cobrado: number, total: number): boolean {
    return Math.abs(Math.round(cobrado * 100) - Math.round(total * 100)) <= TOLERANCIA_CENTIMOS;
  }
}
