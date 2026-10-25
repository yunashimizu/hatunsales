import type { EfectoNotaCredito } from '../../../bussnies/Bussnies/nota-credito.contrato';
import type { AnulacionResponse, ComprobanteResponse, MotivoNotaResponse } from './comprobante.response';

/** Motivo del catálogo 09 que admite el comprobante, con lo que hace el sistema cuando SUNAT acepta la nota. */
export interface MotivoNotaCreditoContexto {
  codigo: string;
  nombre: string;
  forma: MotivoNotaResponse['forma'];
  efecto: EfectoNotaCredito;
  /** Valor por defecto de reingresar_stock; null si el motivo no devuelve mercadería. */
  reingresar_stock: boolean | null;
  /** Advertencia propia del motivo (p. ej. 02: emita aparte el comprobante correcto). */
  aviso: string | null;
}

/** Línea del comprobante origen con lo que ya acreditaron las notas vigentes. */
export interface ItemNotaCreditoContexto {
  id_item: number;
  id_producto: number | null;
  codigo: string | null;
  descripcion: string;
  unidad: string;
  /** 1 gravado, 8 exonerado, 9 inafecto. */
  tipo_de_igv: number;
  cantidad_origen: number;
  cantidad_acreditada: number;
  cantidad_disponible: number;
  /** Precio unitario con IGV del origen. */
  precio_unitario: number;
  /** Descuento por unidad con IGV del origen (descuento de la línea entre la cantidad). */
  descuento_unitario: number;
  /** Importe de la línea en el origen, con IGV. */
  total_origen: number;
  /** Lo que todavía se puede acreditar de la línea, con IGV. */
  importe_disponible: number;
  /** Recargo por pago con tarjeta: no se elige, se acredita solo en proporción a lo devuelto. */
  es_recargo: boolean;
}

export interface NotaPreviaContexto {
  id: number;
  serie: string;
  numero: number;
  numero_formateado: string;
  motivo: string | null;
  total: number;
  estado_sunat: string | null;
  /** Cuenta para el saldo: no anulada, sin error y no rechazada por SUNAT. */
  vigente: boolean;
  /** Su envío a SUNAT todavía no termina (otra nota no se puede emitir mientras tanto). */
  en_curso: boolean;
}

/** GET /comprobante/:id/nota-credito/contexto: todo lo que el asistente necesita para armar la nota. */
export interface ContextoNotaCreditoResponse {
  permitido: boolean;
  motivo_no_permitido?: string;
  origen: {
    id: number;
    /** Catálogo 01: '01' factura, '03' boleta. */
    tipo: string;
    serie: string;
    numero: number;
    numero_formateado: string;
    /** Fecha de emisión tal como se guardó (dd-mm-aaaa). */
    fecha: string;
    cliente: { tipo_documento: number; numero_documento: string; denominacion: string };
    moneda: 'PEN' | 'USD';
    total: number;
    ambiente_fiscal: string | null;
    estado_sunat: string | null;
  };
  /** Total del origen menos las notas de crédito vigentes. */
  saldo: number;
  items: ItemNotaCreditoContexto[];
  /** Solo los motivos que el comprobante admite hoy. */
  motivos: MotivoNotaCreditoContexto[];
  notas_previas: NotaPreviaContexto[];
  venta?: {
    id: number;
    estado: string;
    /** La venta tiene una cuenta por cobrar (se vendió al crédito, total o parcialmente). */
    a_credito: boolean;
    /** Lo que todavía se debe; una nota aceptada lo baja (hasta su total). */
    saldo_cxc: number;
    /** Parte de la venta que se cobró con medios distintos del crédito (efectivo, tarjeta, Yape…). */
    pagada_al_contado: boolean;
  };
  avisos: string[];
}

/** POST /comprobante/:id/nota-credito. */
export interface NotaCreditoEmitidaResponse extends ComprobanteResponse {
  efecto: EfectoNotaCredito;
  /** true si SUNAT ya la aceptó y sus efectos (stock, cuenta por cobrar) quedaron aplicados. */
  efectos_aplicados: boolean;
  avisos: string[];
}

/** Nota de crédito con la que se anula un comprobante aceptado (D9, rama c). */
export interface NotaAnulacionResponse {
  id_comprobante: number;
  serie: string;
  numero: number;
  numero_formateado: string;
  /** 01 (anulación de la operación) o 07 (devolución de lo que quedaba, si ya había notas previas). */
  motivo: string;
  total: number;
  /** 'emitido' (aceptada) | 'pendiente' (envío en curso) | 'error' (rechazada o no aceptada). */
  estado: string;
  estado_sunat: string | null;
  aceptada_sunat: boolean;
  error?: string;
}

/**
 * anulada: la venta (o el comprobante) quedó anulada. anulacion_en_curso: se emitió la nota y se anula
 * cuando SUNAT la acepte. anulacion_rechazada: SUNAT rechazó la nota; nada cambió.
 */
export type EstadoAnulacion = 'anulada' | 'anulacion_en_curso' | 'anulacion_rechazada';

/** POST /venta/:id/anular (D9). */
export interface AnulacionVentaResponse {
  estado: EstadoAnulacion;
  id_venta: number;
  /** true si la venta ya quedó anulada (en esta petición o antes). */
  anulada: boolean;
  ya_anulada?: boolean;
  nota?: NotaAnulacionResponse;
  /** Comprobantes anulados en el sistema (nunca enviados, históricos o de otro ambiente). */
  comprobantes_anulados: { id_comprobante: number; numero_formateado: string }[];
  stock_devuelto: boolean;
  cxc_cerradas: number;
  avisos: string[];
}

/** POST /comprobante/anular (D9 aplicado al comprobante). Conserva los campos de la respuesta anterior. */
export interface AnulacionDocumentoResponse extends AnulacionResponse {
  estado: EstadoAnulacion;
  id_comprobante: number;
  numero_formateado: string;
  id_venta: number | null;
  /** Estado de la venta después de la petición ('activa' | 'anulada'); null si el comprobante no tiene venta. */
  venta_estado: string | null;
  nota?: NotaAnulacionResponse;
  avisos: string[];
}

/** POST /comprobante/consultar-anulacion. */
export interface ConsultaAnulacionResponse extends AnulacionResponse {
  estado: EstadoAnulacion | 'sin_anulacion';
  id_comprobante: number;
  numero_formateado: string;
  nota?: NotaAnulacionResponse;
  avisos: string[];
}
