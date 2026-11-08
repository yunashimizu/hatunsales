import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatosComprobantePedido, VentaTiendaRepository } from '../../../repository/Repository/tienda/venta-tienda.repository';
import { VentaBussnies } from '../venta.bussnies';
import { ComprobanteBussnies } from '../comprobante.bussnies';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../../../sunat/auditoria/fiscal-auditoria.repository';
import type { EmitirComprobanteVentaRequest } from '../../../models/model/venta/venta.request';
import type { ComprobanteResponse } from '../../../models/model/c-electronico/comprobante.response';

const TIPO_FACTURA = 1;
const TIPO_BOLETA = 2;
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Estado del comprobante de un pedido web, en palabras que entiende quien atiende la tienda. */
export type EstadoComprobantePedido =
  | 'aceptado'
  | 'en_proceso'
  | 'requiere_revision'
  | 'rechazado'
  | 'anulado'
  | 'sin_comprobante';

export interface ComprobantePedidoResponse {
  estado: EstadoComprobantePedido;
  id_comprobante?: number;
  /** B001-123 */
  numero_formateado?: string;
  tipo?: 'boleta' | 'factura';
  estado_sunat?: string;
  /** El comprador puede bajar el PDF (existe y no está rechazado ni anulado). */
  puede_descargar: boolean;
  /** Solo para el personal: por qué el pedido quedó sin comprobante. */
  motivo?: string;
}

export interface ResultadoEmisionPedido {
  emitido: boolean;
  omitido?: boolean;
  id_comprobante?: number;
  motivo?: string;
}

/**
 * Comprobante de los pedidos de la tienda web (SUNAT-3, S5).
 *
 * Al confirmarse el pago, la venta que nace del pedido recibe su boleta o factura con los datos que el comprador
 * dejó en el checkout. Va con envío diferido (la confirmación no espera a SUNAT) y con el correo del comprador. Un
 * fallo aquí NUNCA deshace la confirmación del pago: la venta queda en «Ventas sin comprobante» y el motivo en la
 * bitácora fiscal, para mostrarlo en la ficha del pedido.
 */
@Injectable()
export class PedidoComprobanteBussnies {

  private readonly log = new Logger(PedidoComprobanteBussnies.name);

  constructor(
    private readonly ventaRepo: VentaTiendaRepository,
    private readonly ventas: VentaBussnies,
    private readonly comprobantes: ComprobanteBussnies,
    private readonly auditoria: FiscalAuditoriaRepository,
  ) {}

  /**
   * Intenta emitir el comprobante de la venta recién creada. Nunca lanza: devuelve el resultado y lo deja en la
   * bitácora (`FISCAL_PEDIDO_WEB_EMITIDO`), con éxito o con el motivo del fallo.
   */
  async emitirDePedido(idPedido: number, idVenta: number): Promise<ResultadoEmisionPedido> {
    try {
      const estado = await this.comprobantes.emisionDisponible();
      if (!estado.activo) {
        // Emisión apagada: no se intenta, no es un fallo. La venta se emite después desde «Ventas sin comprobante».
        return { emitido: false, omitido: true, motivo: `La emisión electrónica no está activa (${estado.motivo ?? 'sin detalle'}).` };
      }

      const datos = await this.ventaRepo.datosParaComprobante(idPedido);
      if (!datos) return await this.fallo(idPedido, idVenta, 'No se encontró el pedido para armar su comprobante.');

      const solicitud = this.solicitudDe(datos);
      if (typeof solicitud === 'string') return await this.fallo(idPedido, idVenta, solicitud);

      const venta = await this.ventas.emitirComprobanteDeVenta(idVenta, solicitud.dto, undefined, {
        forzarDiferido: true,
        correo_cliente: solicitud.correo,
      });

      const comprobante = venta.comprobante;
      if (!comprobante?.id_comprobante) {
        return await this.fallo(idPedido, idVenta, venta.comprobante_error || 'La emisión no devolvió un comprobante.');
      }

      await this.registrar(idPedido, idVenta, {
        resultado: 'ok',
        id_comprobante: comprobante.id_comprobante,
        numero: comprobante.numero_formateado,
        tipo: datos.tipo_comprobante,
        correo: solicitud.correo ? 'si' : 'no',
      });
      try {
        await this.ventaRepo.vincularComprobante(idPedido, comprobante.id_comprobante);
      } catch (error: any) {
        // El enlace del pedido es una comodidad: la ficha también encuentra el comprobante por la venta.
        this.log.warn(`Pedido ${idPedido}: comprobante ${comprobante.id_comprobante} emitido, pero no se pudo enlazar al pedido: ${error?.message}`);
      }
      return { emitido: true, id_comprobante: comprobante.id_comprobante };
    } catch (error: any) {
      // Otro proceso ya le emitió su comprobante (p. ej. desde «Ventas sin comprobante»): no es un fallo.
      if (error?.response?.codigo === 'VENTA_CON_COMPROBANTE') {
        return { emitido: true, id_comprobante: error.response.id_comprobante };
      }
      return await this.fallo(idPedido, idVenta, this.mensajeDe(error));
    }
  }

  /** Estado del comprobante del pedido para la ficha del panel (`paraPersonal`) o para el comprador. */
  async resumenDe(
    pedido: { id_pedido: number; id_venta?: number | null; tipo_comprobante?: string | null; estado?: string | null },
    paraPersonal: boolean,
  ): Promise<ComprobantePedidoResponse> {
    const idVenta = pedido.id_venta ? Number(pedido.id_venta) : null;
    const comprobante = idVenta ? (await this.comprobantes.listarPorVenta(idVenta))[0] : undefined;
    if (comprobante?.id_comprobante) return this.resumenDeComprobante(comprobante, pedido.tipo_comprobante);

    const sin: ComprobantePedidoResponse = { estado: 'sin_comprobante', puede_descargar: false };
    if (paraPersonal) sin.motivo = await this.motivoSinComprobante(pedido, idVenta);
    return sin;
  }

  /**
   * PDF del comprobante para quien hizo el pedido. Solo el dueño del pedido y solo si el comprobante existe y
   * sigue vigente (un rechazado o anulado no se entrega).
   */
  async pdfParaCliente(idPedido: number, idCliente: number, pedido: { id_venta?: number | null; cliente?: { id_cliente?: number } | null; tipo_comprobante?: string | null } | null) {
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (pedido.cliente?.id_cliente !== idCliente) throw new ForbiddenException('Este pedido no te pertenece');

    const resumen = await this.resumenDe({ id_pedido: idPedido, id_venta: pedido.id_venta, tipo_comprobante: pedido.tipo_comprobante }, false);
    if (!resumen.puede_descargar || !resumen.id_comprobante) {
      throw new NotFoundException('Tu comprobante todavía no está disponible. Si pagaste hace poco, vuelve a intentarlo en unos minutos.');
    }
    return this.comprobantes.obtenerPdf(resumen.id_comprobante, 'a4');
  }

  // ── Interno ──────────────────────────────────────────────────

  private resumenDeComprobante(c: ComprobanteResponse, tipoPedido?: string | null): ComprobantePedidoResponse {
    const estadoSunat = c.estado_sunat ?? undefined;
    let estado: EstadoComprobantePedido = 'en_proceso';
    if (c.anulado) estado = 'anulado';
    else if (c.aceptada_sunat) estado = 'aceptado';
    else if (estadoSunat === 'RECHAZADO') estado = 'rechazado';
    else if (estadoSunat === 'EXCEPCION') estado = 'requiere_revision';
    const esFactura = c.tipo_de_comprobante === TIPO_FACTURA || (c.tipo_de_comprobante === undefined && tipoPedido === 'factura');
    return {
      estado,
      id_comprobante: c.id_comprobante,
      numero_formateado: c.numero_formateado,
      tipo: esFactura ? 'factura' : 'boleta',
      estado_sunat: estadoSunat,
      puede_descargar: estado === 'aceptado' || estado === 'en_proceso',
    };
  }

  private async motivoSinComprobante(
    pedido: { id_pedido: number; estado?: string | null },
    idVenta: number | null,
  ): Promise<string> {
    if (!idVenta) {
      return pedido.estado === 'pendiente'
        ? 'El pedido aún no está pagado: el comprobante se emite al confirmar el pago.'
        : pedido.estado === 'cancelado'
          ? 'El pedido está cancelado.'
          : 'El pedido no generó venta; sin venta no hay comprobante.';
    }
    try {
      const ultimo = await this.auditoria.ultimoDeEntidad(ACCIONES_AUDITORIA_FISCAL.PEDIDO_WEB_EMITIDO, 'pedido', pedido.id_pedido);
      const motivo = ultimo?.detalle && (ultimo.detalle as any).motivo;
      if (motivo) return String(motivo);
    } catch (error: any) {
      this.log.warn(`Pedido ${pedido.id_pedido}: no se pudo leer el último intento de comprobante: ${error?.message}`);
    }
    return 'No se emitió automáticamente. Emítalo desde «Ventas sin comprobante».';
  }

  /** Arma la solicitud para el comprobante del pedido, o devuelve el texto de por qué no se puede. */
  private solicitudDe(datos: DatosComprobantePedido): { dto: EmitirComprobanteVentaRequest; correo?: string } | string {
    const documento = (datos.documento_receptor ?? '').replace(/\D/g, '');
    const esFactura = datos.tipo_comprobante === 'factura';

    if (esFactura && !/^(10|15|17|20)\d{9}$/.test(documento)) {
      return `El comprador pidió factura, pero el pedido no trae un RUC válido (${datos.documento_receptor ?? 'sin RUC'}). Corrija el RUC y emita la factura desde «Ventas sin comprobante».`;
    }

    const dto: EmitirComprobanteVentaRequest = {
      id_tipo: esFactura ? TIPO_FACTURA : TIPO_BOLETA,
      observaciones: `Pedido web ${datos.codigo}`,
    };
    // Boleta: el DNI solo si es un DNI; sin él se usa al cliente de la tienda (o consumidor final si es poco monto).
    if (esFactura || /^\d{8}$/.test(documento)) dto.documento = documento;
    if (datos.nombre_receptor) dto.cliente_denominacion = datos.nombre_receptor.slice(0, 200);
    if (datos.direccion) dto.cliente_direccion = datos.direccion.slice(0, 255);

    const correo = datos.correo && CORREO_VALIDO.test(datos.correo) ? datos.correo : undefined;
    return { dto, correo };
  }

  private async fallo(idPedido: number, idVenta: number, motivo: string): Promise<ResultadoEmisionPedido> {
    this.log.warn(`Pedido ${idPedido} (venta ${idVenta}) quedó sin comprobante: ${motivo}`);
    await this.registrar(idPedido, idVenta, { resultado: 'sin_comprobante', motivo });
    return { emitido: false, motivo };
  }

  private async registrar(idPedido: number, idVenta: number, detalle: Record<string, unknown>): Promise<void> {
    try {
      await this.auditoria.registrar({
        accion: ACCIONES_AUDITORIA_FISCAL.PEDIDO_WEB_EMITIDO,
        entidad: 'pedido',
        id_entidad: idPedido,
        detalle: { id_venta: idVenta, ...detalle },
      });
    } catch (error: any) {
      this.log.warn(`Pedido ${idPedido}: no se pudo registrar el intento de comprobante en la bitácora: ${error?.message}`);
    }
  }

  private mensajeDe(error: any): string {
    const respuesta = error?.response;
    const mensaje = Array.isArray(respuesta?.message) ? respuesta.message.join(' | ') : respuesta?.message ?? error?.message;
    return String(mensaje ?? 'No se pudo emitir el comprobante').slice(0, 480);
  }
}
