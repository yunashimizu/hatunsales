import type { ActorFiscal, AmbienteFiscal } from '../config/fiscal-config.tipos';
import type { ArchivoEnvio, TipoArchivoEnvio } from '../emision/emision.contrato';

/**
 * Contrato de los lotes fiscales: la comunicación de baja (RA, facturas) y el resumen diario con la
 * condición 3 «anular» (RC, boletas) con que se anula un comprobante ya aceptado SIN nota de crédito.
 *
 * Lo implementa LotesFiscalesService (src/sunat/documentos) y lo consume el negocio (NotaCreditoBussnies,
 * ComprobanteBussnies, EfectosNotasTarea) por este token de DI, sin conocer SOAP, tickets ni SQL de envíos.
 * Si hace falta un campo nuevo, agréguelo como OPCIONAL.
 *
 * Flujo: solicitarAnulacion() arma y firma el XML, lo registra con el comprobante en BAJA_PENDIENTE y lo
 * manda a SUNAT (sendSummary devuelve un ticket). La tarea consulta el ticket hasta que SUNAT responde:
 * ACEPTADO deja el comprobante ANULADO y avisa a los oyentes (el negocio anula la venta); RECHAZADO
 * devuelve el comprobante a su estado anterior.
 */

/** Tipo de lote: RA = baja de facturas; RC = resumen diario de boletas (condición 3 «anular» y condición 1 «adicionar»). */
export type OperacionLote = 'baja' | 'resumen';

/** Tope de filas por página en el listado de lotes (la implementación lo aplica aunque pidan más). */
export const MAXIMO_LOTES_POR_PAGINA = 100;

/** Comprobante incluido en un lote (una fila de fiscal_resumen_lineas). */
export interface LineaLoteVista {
  id_comprobante: number;
  serie: string | null;
  numero: number | null;
  /** Catálogo 01 del comprobante ('01' | '03'); null si el tipo interno no es un comprobante electrónico. */
  tipo_documento: string | null;
  /** Catálogo 19: 1 adicionar, 2 modificar, 3 anular. Las bajas (RA) usan 3. */
  condicion: number;
  /** PENDIENTE de respuesta: el estado SUNAT que tenía el comprobante; luego ACEPTADO o RECHAZADO. */
  estado: string | null;
}

export interface LoteVista {
  id_envio: number;
  ambiente: AmbienteFiscal;
  operacion: OperacionLote;
  /** RA-YYYYMMDD-NNNNN o RC-YYYYMMDD-NNNNN. */
  identificador: string;
  /** ENVIANDO | TICKET_PENDIENTE | PENDIENTE_REENVIO | ACEPTADO | ACEPTADO_OBS | RECHAZADO | EXCEPCION | ERROR_CONFIG. */
  estado: string;
  sunat_ticket: string | null;
  codigo_sunat: string | null;
  mensaje_sunat: string | null;
  /** Qué hacer a continuación (AccionSunat del clasificador), si aplica. */
  accion_sunat: string | null;
  /** yyyy-mm-dd: día de emisión de los documentos del lote (cbc:ReferenceDate). */
  fecha_referencia: string | null;
  intento: number;
  proximo_intento_en: string | null;
  creado_en: string;
  actualizado_en: string | null;
  archivos: TipoArchivoEnvio[];
  lineas: LineaLoteVista[];
}

/** Lo que el negocio necesita saber del lote vigente de un comprobante (sin las líneas). */
export interface LoteDeComprobante {
  id_envio: number;
  operacion: OperacionLote;
  identificador: string;
  estado: string;
  sunat_ticket: string | null;
  mensaje: string | null;
}

export interface ResultadoLote {
  id_envio: number;
  operacion: OperacionLote;
  identificador: string;
  estado: string;
  /** SUNAT ya aceptó el lote (con o sin observaciones). */
  aceptado: boolean;
  ticket: string | null;
  mensaje: string | null;
  codigo: string | null;
}

export interface FiltroLotes {
  ambiente?: AmbienteFiscal;
  operacion?: OperacionLote;
  estado?: string;
  pagina?: number;
  /** Máximo MAXIMO_LOTES_POR_PAGINA. */
  por_pagina?: number;
}

/** Línea ACEPTADA de un lote cuyo comprobante todavía no quedó anulado en el sistema (barrido de efectos). */
export interface LineaAceptadaSinAnular {
  id_envio: number;
  id_comprobante: number;
}

/** Quién pide el resumen de adición: el administrador (botón), la tarea programada o la acción de un comprobante. */
export type OrigenResumen = 'manual' | 'tarea' | 'comprobante';

export interface PeticionResumenAdicion {
  /** yyyy-mm-dd: día de emisión de las boletas (un resumen lleva boletas de UNA sola fecha). */
  fecha_emision: string;
  /** Solo estos comprobantes (los que sigan elegibles); sin ids, todos los elegibles de la fecha. */
  ids_comprobantes?: number[];
  actor: ActorFiscal | null;
  origen: OrigenResumen;
}

export interface ResultadoResumenAdicion extends ResultadoLote {
  fecha_emision: string;
  /** Boletas (y notas de boleta) incluidas en el resumen. */
  comprobantes: number;
  /** Elegibles que no cupieron (un resumen admite 500 líneas): se informan en el siguiente. */
  pendientes: number;
  /** Elegibles que no se incluyeron porque no conservan su documento o es de otro emisor. */
  omitidos: number;
}

export abstract class LotesFiscales {
  /**
   * Da de baja (factura, RA) o informa como anulada (boleta, RC condición 3) un comprobante aceptado,
   * dentro de los 7 días de su emisión. Registra el lote con el comprobante en BAJA_PENDIENTE y lo envía.
   * FiscalConfigError: FISCAL_BAJA_FUERA_DE_PLAZO, FISCAL_DOC_NO_ENCONTRADO, FISCAL_ENVIO_EN_CURSO,
   * FISCAL_CONFIG_INVALIDA (no admite la baja), FISCAL_AMBIENTE_CAMBIO.
   */
  abstract solicitarAnulacion(p: { id_comprobante: number; motivo: string; idUsuario: number | null }): Promise<ResultadoLote>;

  /**
   * Resumen diario de adición (RC, condición 1): informa a SUNAT las boletas y notas de boleta de UNA fecha de
   * emisión que esperan resumen (POR_RESUMIR) o que no pudieron ir por envío individual y ya pasaron los 5 días,
   * dentro de los 7 días de la emisión. Nunca incluye lo que SUNAT ya aceptó. Mientras el resumen está en curso los
   * comprobantes quedan TICKET_PENDIENTE; aceptado → ACEPTADO; rechazado → vuelven a su estado anterior.
   * Devuelve null si no hay nada que informar. FiscalConfigError: FISCAL_RESUMEN_FUERA_DE_PLAZO, FISCAL_EMISION_BLOQUEADA,
   * FISCAL_ENVIO_EN_CURSO (otro proceso tomó alguna boleta a la vez).
   */
  abstract crearResumenAdicion(p: PeticionResumenAdicion): Promise<ResultadoResumenAdicion | null>;

  /**
   * «Informar por resumen» de UNA boleta (o nota de boleta): valida que pueda ir (tipo, estado, plazo de 7 días) y
   * crea el resumen de su fecha con ella sola. FISCAL_RESUMEN_NO_PERMITIDO / FISCAL_RESUMEN_FUERA_DE_PLAZO si no.
   */
  abstract resumirComprobante(p: { id_comprobante: number; actor: ActorFiscal | null }): Promise<ResultadoResumenAdicion>;

  /** Último lote de baja o anulación del comprobante que sigue vigente (en curso o aceptado); null si no tiene o fue rechazado. */
  abstract estadoDeComprobante(idComprobante: number): Promise<LoteDeComprobante | null>;

  abstract listar(filtro: FiltroLotes): Promise<{ datos: LoteVista[]; total: number; pagina: number; por_pagina: number }>;

  abstract obtener(idEnvio: number): Promise<LoteVista | null>;

  /** Envía el lote si está PENDIENTE_REENVIO, o consulta su ticket si está TICKET_PENDIENTE. */
  abstract reintentar(idEnvio: number): Promise<ResultadoLote>;

  /**
   * «Liberar» (administrador): suelta un lote cuyo ticket SUNAT no resolvió; los comprobantes vuelven a su
   * estado anterior. Auditado (FISCAL_LOTE_LIBERADO). FISCAL_LIBERAR_NO_PERMITIDO si no está en ese caso.
   */
  abstract liberar(idEnvio: number, actor: ActorFiscal): Promise<ResultadoLote>;

  abstract archivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null>;

  /** Líneas de lotes aceptados cuyo comprobante sigue sin anular: las recorre el barrido de efectos. */
  abstract lineasAceptadasSinAnular(limite: number): Promise<LineaAceptadaSinAnular[]>;
}
