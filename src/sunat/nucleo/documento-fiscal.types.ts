/**
 * Contrato del núcleo fiscal de SUNAT directo (SEE - Del Contribuyente).
 *
 * Lo comparten el mapper (comprobante → DocumentoCpe), las validaciones, los
 * builders UBL, la firma, el cliente SOAP y el clasificador de respuestas.
 * No depende de Nest ni de la base de datos.
 *
 * Regla de importes: las líneas llegan YA calculadas por
 * util/fiscal/calculo-fiscal.ts (precios con IGV incluido y desagregado hacia
 * atrás). El núcleo nunca recalcula impuestos: valida que cuadren y los
 * escribe con el redondeo que exige SUNAT. Así XML = BD = PDF.
 */

import type { MaterialFirma } from '../certificado/material-firma';

/** Material de firma (clave + certificado en memoria). Es el tipo de src/sunat/certificado/material-firma.ts. */
export type { MaterialFirma };

export type AmbienteFiscal = 'beta' | 'produccion';

/** Catálogo 01: 01 factura, 03 boleta, 07 nota de crédito, 08 nota de débito. */
export type TipoCpe = '01' | '03' | '07' | '08';

export type MonedaCpe = 'PEN' | 'USD';

/** Catálogo 07 (afectación del IGV) en su subconjunto oneroso: gravado, exonerado e inafecto. */
export type AfectacionCpe = '10' | '20' | '30';

export interface EmisorCpe {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  direccion: string;
  ubigeo: string;
  distrito: string;
  provincia: string;
  departamento: string;
  /** Código de establecimiento anexo registrado en SUNAT ('0000' = domicilio fiscal). */
  codigoEstablecimiento: string;
}

export interface ClienteCpe {
  /** Catálogo 06: '0' sin documento, '1' DNI, '4' carné de extranjería, '6' RUC, '7' pasaporte… */
  tipoDoc: string;
  numDoc: string;
  nombre: string;
  direccion?: string;
}

export interface LineaCpe {
  cantidad: number;
  /** Unidad del catálogo 03 (UN/ECE rec 20). */
  unidad: string;
  descripcion: string;
  codigoInterno?: string;
  /** Código de producto SUNAT (UNSPSC, catálogo 25) de 8 dígitos. */
  codigoSunat?: string;
  afectacion: AfectacionCpe;
  porcentajeIgv: number;
  /** Valor unitario SIN IGV y ANTES del descuento (hasta 10 decimales). */
  valorUnitario: number;
  /** Precio unitario CON IGV y con el descuento aplicado (total / cantidad). */
  precioVentaUnitario: number;
  /** Descuento que afecta la base imponible, SIN IGV (catálogo 53, código 00). */
  descuentoBase: number;
  /** Base imponible de la línea (valor de venta neto, sin IGV). */
  valorVenta: number;
  igv: number;
  /** Lo que paga el cliente por la línea (valorVenta + igv). */
  total: number;
}

export interface CuotaCpe {
  numero: number;
  monto: number;
  /** yyyy-mm-dd, posterior a la fecha de emisión. */
  fechaPago: string;
}

export interface FormaPagoCpe {
  tipo: 'Contado' | 'Credito';
  /** Monto neto pendiente de pago (obligatorio al crédito). */
  montoPendiente?: number;
  cuotas?: CuotaCpe[];
}

export interface ReferenciaNotaCpe {
  tipoDoc: '01' | '03';
  serie: string;
  numero: number;
  /** Catálogo 09 (nota de crédito) o 10 (nota de débito). */
  motivo: string;
  sustento: string;
}

export interface TotalesCpe {
  gravada: number;
  exonerada: number;
  inafecta: number;
  igv: number;
  /** Suma de los descuentos por línea (sin IGV). Informativo: no viaja como total en el XML. */
  descuentos: number;
  total: number;
}

export interface DocumentoCpe {
  tipo: TipoCpe;
  serie: string;
  numero: number;
  /** yyyy-mm-dd en hora de Lima. */
  fechaEmision: string;
  /** HH:mm:ss en hora de Lima. */
  horaEmision: string;
  fechaVencimiento?: string;
  moneda: MonedaCpe;
  emisor: EmisorCpe;
  cliente: ClienteCpe;
  lineas: LineaCpe[];
  totales: TotalesCpe;
  formaPago?: FormaPagoCpe;
  /** Leyenda 1000 (importe en letras). Si no llega, el builder la calcula. */
  leyendaMontoLetras?: string;
  /** Solo para la representación impresa: no viaja en el XML. */
  observaciones?: string;
  /** Obligatoria en notas de crédito y débito. */
  referencia?: ReferenciaNotaCpe;
}

/**
 * Lo que SUNAT dijo sobre una consulta de estado (billConsultService o
 * getStatus de un ticket) cuando la respuesta no trae la constancia (CDR).
 */
export type EstadoComprobanteSunat = 'ACEPTADO' | 'RECHAZADO' | 'DE_BAJA' | 'NO_EXISTE' | 'DESCONOCIDO';

export interface ObservacionSunat {
  codigo: string;
  descripcion: string;
}

/**
 * Respuesta normalizada de cualquier operación SOAP:
 *  - CDR: llegó la constancia (sendBill, getStatus con content, getStatusCdr con content).
 *  - TICKET: sendSummary aceptó el lote, o getStatus sigue en proceso (statusCode 98).
 *  - ESTADO: consulta sin constancia (billConsultService, o getStatus 99 sin content);
 *    `codigo` = statusCode y `estadoComprobante` su significado.
 *  - FAULT: SOAP Fault (excepción o rechazo); `codigo` = 4 dígitos normalizados.
 *  - TRANSPORTE: red, timeout, HTTP sin Fault o respuesta ilegible.
 *  - NO_DISPONIBLE: la operación no existe en el ambiente (consultas en BETA).
 */
export interface RespuestaSunat {
  tipo: 'CDR' | 'TICKET' | 'ESTADO' | 'FAULT' | 'TRANSPORTE' | 'NO_DISPONIBLE';
  /** ResponseCode del CDR, código del Fault (4 dígitos), statusCode o código de red (ETIMEDOUT, HTTP_503…). */
  codigo: string;
  descripcion: string;
  observaciones: ObservacionSunat[];
  cdrZip?: Buffer;
  cdrXml?: string;
  ticket?: string;
  statusCode?: string;
  httpStatus?: number;
  tiempoMs: number;
  /** Respuesta cruda redactada (sin credenciales) y truncada a 20 KB. */
  raw?: string;
  /** Solo en respuestas ESTADO: qué dice SUNAT del comprobante. */
  estadoComprobante?: EstadoComprobanteSunat;
}

export type EstadoSunat =
  | 'NO_ENVIADO'
  | 'POR_RESUMIR'
  | 'ENVIANDO'
  | 'PENDIENTE_REENVIO'
  | 'TICKET_PENDIENTE'
  | 'ACEPTADO'
  | 'ACEPTADO_OBS'
  | 'RECHAZADO'
  | 'EXCEPCION'
  | 'ERROR_CONFIG'
  | 'BAJA_PENDIENTE'
  | 'ANULADO';

export type AccionSunat =
  | 'NINGUNA'
  | 'REINTENTAR'
  | 'CORREGIR_Y_REENVIAR'
  | 'EMITIR_NUEVO'
  | 'RECUPERAR_CDR'
  | 'REVISAR_CONFIG'
  | 'CONSULTAR_TICKET';

export type OperacionSunat = 'emitir' | 'resumen' | 'baja' | 'consulta';

export interface ContextoClasificacion {
  operacion: OperacionSunat;
  tipo?: TipoCpe;
  /** 'consulta_ticket' cuando la respuesta viene de getStatus(ticket) de un RC o RA. */
  etapa?: 'envio' | 'consulta_ticket';
}

export interface ClasificacionRespuesta {
  estado: EstadoSunat;
  accion: AccionSunat;
  mensajeUsuario: string;
}

export interface ResultadoValidacionCpe {
  errores: string[];
  advertencias: string[];
}

export interface OpcionesValidacionCpe {
  /** Fecha de referencia (yyyy-mm-dd o Date). Por omisión, hoy en Lima. */
  hoy?: string | Date;
  /**
   * Reglas de la RS 000048-2026 (postergadas al 01/01/2027 por la RS 000143-2026).
   * 'auto' u omitido: se aplican si la fecha de emisión es desde 2027-01-01.
   */
  aplicarReglas2027?: boolean | 'auto';
  /** Saldo del comprobante modificado (total − notas de crédito previas). Si llega, la NC no puede superarlo. */
  montoMaximoNota?: number;
}

export interface ResultadoXmlCpe {
  xml: string;
  /** RUC-TT-SERIE-NNNNNNNN: nombre del .xml y del .zip, sin extensión. */
  nombreBase: string;
}

export interface ResultadoFirmaXml {
  xmlFirmado: string;
  /** ds:DigestValue en base64: es el "valor resumen" del comprobante. */
  digestValue: string;
  signatureValue: string;
}

export interface PaqueteZip {
  /** nombreBase + '.zip' (es el fileName del SOAP). */
  nombreZip: string;
  /** nombreBase + '.xml' (la única entrada del ZIP). */
  nombreXml: string;
  zip: Buffer;
  base64: string;
  /** SHA-256 del ZIP en hexadecimal (hashZip de la GRE por API REST). */
  sha256: string;
}

export interface DatosCadenaQr {
  ruc: string;
  tipo: TipoCpe;
  serie: string;
  numero: number;
  igv: number;
  total: number;
  /** yyyy-mm-dd */
  fechaEmision: string;
  tipoDocAdq?: string | null;
  numDocAdq?: string | null;
  /** DigestValue (valor resumen) en base64. */
  digest?: string | null;
}
