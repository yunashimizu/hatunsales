import type { ConsultarComprobanteRequest, ItemComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import type { ComprobanteResponse } from '../../models/model/c-electronico/comprobante.response';
import type { AnularDocumentoRequest } from '../../models/model/c-electronico/nota-credito.request';
import type { AnulacionDocumentoResponse, ConsultaAnulacionResponse } from '../../models/model/c-electronico/nota-credito.response';
import type { ConsultorTx } from '../../sunat/emision/emision.contrato';

/**
 * Contrato entre el negocio de notas de crédito y el motor de comprobantes.
 *
 * NotaCreditoBussnies decide QUÉ se acredita (motivo, ítems, cantidades, saldo,
 * stock y enlace con la venta) y entrega la nota ya armada. El motor
 * (ComprobanteBussnies) la EMITE: serie, número, XML, firma, envío a SUNAT y
 * persistencia. Así las líneas de la nota se calculan con la misma función que
 * las de la factura o boleta y no hay dos copias de la lógica fiscal.
 */

/** Línea de la nota, copiada del ítem del comprobante origen (precio y descuento CON IGV, como en la venta). */
export interface LineaNotaCredito extends ItemComprobanteRequest {
  /**
   * comprobante_items.id_item del origen: lleva la cuenta de lo ya acreditado por ítem.
   * Null solo en la línea de ajuste de los motivos por monto (09 disminución en el valor, 10 otros).
   */
  id_item_origen: number | null;
}

/** Qué hace el negocio cuando SUNAT ACEPTA la nota (nunca antes): lo aplica una sola vez el oyente de envíos. */
export type EfectoNotaCredito = 'ninguno' | 'devolucion' | 'anular_venta';

export interface SolicitudEmisionNotaCredito {
  /** Factura (01) o boleta (03) aceptada por SUNAT que se corrige. */
  id_comprobante_origen: number;
  /** Venta del comprobante origen: la nota queda enlazada a la misma venta. */
  id_venta: number | null;
  /** Catálogo 09 de SUNAT. */
  motivo: string;
  /** Sustento que viaja en el XML (3 a 250 caracteres). */
  sustento: string;
  lineas: LineaNotaCredito[];
  /** Saldo acreditable del origen ANTES de esta nota; es el tope que valida el núcleo (montoMaximoNota). */
  saldo_maximo: number;
  id_usuario: number | null;
  efecto: EfectoNotaCredito;
  /** Solo con efecto 'devolucion': si al aceptarse la nota se reingresa al almacén lo devuelto. */
  reingresar_stock: boolean;
  /**
   * Se ejecuta DENTRO de la transacción que reserva el número de la nota, después de
   * `pg_advisory_xact_lock(hashtext('nc:' || id_comprobante_origen))` y ANTES del candado de la serie
   * (orden fijo para no bloquearse). Recalcula con datos frescos el saldo y lo ya acreditado por ítem
   * y lanza ConflictException (otra nota en curso o ya acreditada) o BadRequestException si la nota ya no cabe.
   */
  validarEnTransaccion: (consultor: ConsultorTx) => Promise<void>;
}

/** Notas de crédito de un comprobante resumidas para decidir sus acciones (listado y detalle). */
export interface ResumenNotasOrigen {
  /** Total del comprobante menos sus notas de crédito vigentes (no anuladas, sin error, no rechazadas). */
  saldo: number;
  /** Alguna nota del comprobante sigue en envío a SUNAT. */
  nota_en_curso: boolean;
  /** La nota en curso es la que lo anula (total 01/02/06 o la de «Anular venta»). */
  anulacion_en_curso: boolean;
}

/**
 * Lo que el motor de comprobantes delega en el negocio de notas de crédito (PLAN V3, D9): anular un
 * comprobante desde Documentos, consultar esa anulación y el saldo acreditable de cada comprobante.
 * NotaCreditoBussnies se registra al iniciar el módulo (registrarGestorNotas): así ninguno de los dos
 * se inyecta en el otro y no hay ciclo de dependencias.
 */
export interface GestorNotasCredito {
  anularComprobante(dto: AnularDocumentoRequest, idUsuario: number | null): Promise<AnulacionDocumentoResponse>;
  consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<ConsultaAnulacionResponse>;
  resumenes(idsOrigen: number[]): Promise<Map<number, ResumenNotasOrigen>>;
}

export abstract class EmisorNotasCredito {
  /**
   * Emite la nota con el receptor, la moneda y el % de IGV del comprobante ORIGEN, la serie de
   * nota del ambiente vigente (contexto().series.nc_factura o nc_boleta según el origen) y la
   * referencia al origen. Persiste en `comprobantes` el tipo 7, `id_venta`, `doc_modificado_*`,
   * `id_comprobante_modificado`, `nota_motivo` y `nota_sustento` (y, si las columnas existen,
   * `comprobante_items.id_item_origen`, `comprobantes.efecto_nota`, `reingresar_stock` y
   * `efectos_aplicados=false`).
   *
   * Lanza ServiceUnavailableException si la emisión no está activa (sin reservar número),
   * ConflictException/BadRequestException desde validarEnTransaccion, y BadRequestException si el
   * núcleo rechaza el documento.
   */
  abstract emitirNotaCredito(solicitud: SolicitudEmisionNotaCredito): Promise<ComprobanteResponse>;

  /** Opcional: recibe al negocio de notas para delegarle la anulación (D9) y el saldo de cada comprobante. */
  registrarGestorNotas?(gestor: GestorNotasCredito): void;
}
