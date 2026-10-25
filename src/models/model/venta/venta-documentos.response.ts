import type { AccionSunat, AmbienteFiscal, EstadoSunat } from '../../../sunat/nucleo/documento-fiscal.types';

/**
 * Documentos electrónicos de una venta (PLAN V3, D10): GET /venta/:id/documentos, GET /venta/sin-comprobante
 * y las filas del historial (GET /venta). Gemelas de ferreteria/src/app/admin/models/documentos.models.ts:
 * mismos nombres, tipos y estados; si una cambia, la otra también.
 */

/**
 * Una acción posible sobre la venta. Si no se puede, `motivo` explica por qué en palabras; con
 * `permitido` true, un `motivo` es la advertencia de lo que pasará (p. ej. que hay que verificar en SUNAT).
 */
export interface AccionDocumento {
  permitido: boolean;
  motivo?: string;
}

/** Factura o boleta tal como aparece en los documentos de una venta (las acciones son las de Documentos). */
export interface ComprobanteDeVenta {
  id_comprobante: number;
  /** 1 factura, 2 boleta (ids de `tipos_comprobante`). */
  id_tipo: number;
  tipo_nombre: string;
  serie: string;
  numero: number;
  /** 'F001-00000012'. */
  numero_formateado: string;
  /** Como se guardó en el comprobante (dd-mm-aaaa), igual que en Documentos. */
  fecha_de_emision: string;
  total: number;
  /** comprobantes.estado: 'emitido' | 'pendiente' | 'error'. */
  estado: string;
  anulado: boolean;
  estado_sunat: EstadoSunat | null;
  ambiente_fiscal: AmbienteFiscal | null;
  accion_sunat: AccionSunat | null;
  /** Mensaje de SUNAT o del sistema (último error o descripción del CDR); en un anulado, el motivo de la anulación. */
  mensaje: string | null;
  puede_reintentar: boolean;
  puede_recuperar_cdr: boolean;
  puede_confirmar_manual: boolean;
  puede_nota_credito: boolean;
  puede_anular: boolean;
}

/** Nota de crédito enlazada a la venta. */
export interface NotaDeVenta {
  id_comprobante: number;
  serie: string;
  numero: number;
  numero_formateado: string;
  /** Catálogo 09 ('01', '07'…) y su nombre. */
  motivo: string | null;
  motivo_nombre: string | null;
  total: number;
  estado: string;
  anulado: boolean;
  estado_sunat: EstadoSunat | null;
  /** 'ninguno' | 'devolucion' | 'anular_venta'; null sin la fase14 o en notas históricas. */
  efecto: string | null;
  /** true cuando SUNAT la aceptó y sus efectos (stock, cuenta por cobrar) ya se aplicaron; null sin la fase14. */
  efectos_aplicados: boolean | null;
  /** Comprobante que modifica ('F001-00000012'). */
  doc_modificado: string | null;
}

/** Guía de remisión enlazada a la venta. */
export interface GuiaDeVenta {
  id_guia: number;
  serie: string | null;
  numero: number | null;
  numero_formateado: string | null;
  /** 'legacy' | 'borrador' | 'pendiente' | 'enviado' | 'aceptado' | 'rechazado' | 'anulado'. */
  estado: string;
  estado_texto: string;
  /** aaaa-mm-dd; null en un borrador (el número y la fecha se asignan al emitir). */
  fecha_emision: string | null;
  /** Catálogo 20 ('01' venta…) y su nombre. */
  motivo: string | null;
  motivo_nombre: string | null;
}

/** GET /venta/:id/documentos */
export interface VentaDocumentosResponse {
  venta: {
    id: number;
    /** Fecha y hora de Lima (ISO 8601 con -05:00). */
    fecha: string;
    total: number;
    /** 'activa' | 'anulada'. */
    estado: string;
    cliente: { nombre: string; documento: string | null };
    pagos: { metodo: string; monto: number }[];
    a_credito: boolean;
    /** Saldo pendiente de la cuenta por cobrar (0 si se pagó al contado). */
    saldo_cxc: number;
  };
  /** Comprobante principal vigente (factura o boleta no anulada ni en error), o null si la venta no tiene. */
  comprobante: ComprobanteDeVenta | null;
  /** Facturas y boletas anuladas o con error de la misma venta, de la más reciente a la más antigua. */
  comprobantes_anteriores: ComprobanteDeVenta[];
  /** Notas de crédito de la venta, en el orden en que se emitieron. */
  notas: NotaDeVenta[];
  /** Guías de remisión de la venta, en el orden en que se crearon. */
  guias: GuiaDeVenta[];
  acciones: {
    emitir_comprobante: AccionDocumento;
    nota_credito: AccionDocumento;
    guia: AccionDocumento;
    anular: AccionDocumento;
  };
  /** Avisos en palabras: anulación en curso, nota en curso, comprobante incierto o fuera de plazo… */
  avisos: string[];
}

/** Fila de GET /venta/sin-comprobante */
export interface VentaSinComprobante {
  id_venta: number;
  /** Fecha y hora de Lima (ISO 8601 con -05:00). */
  fecha: string;
  total: number;
  cliente: string;
  documento_cliente: string | null;
  /** Último motivo por el que no se emitió (error del comprobante o, sin ninguno, por qué la emisión no está activa). */
  ultimo_error: string | null;
}

export interface Paginado<T> {
  datos: T[];
  total: number;
  pagina: number;
  por_pagina: number;
}

/**
 * Fila de GET /venta (historial). Conserva los campos que el listado ya devolvía (comprobante,
 * comprobante_estado, id_comprobante, serie y número) y agrega el estado documental.
 */
export interface VentaHistorialFila {
  id_venta: number;
  /** Fecha y hora de Lima (ISO 8601 con -05:00). */
  fecha: string;
  origen: string;
  id_cliente?: number;
  id_empresa?: number;
  cliente_denominacion: string;
  total: number;
  cantidad_items: number;
  /** 'activa' | 'anulada'. */
  estado: string;
  /** Medios de pago usados, separados por coma ('Efectivo, Tarjeta'). */
  metodos_pago: string;
  /** Serie-número del comprobante principal vigente ('F001-00000012'). */
  comprobante?: string;
  comprobante_estado?: string;
  id_comprobante?: number;
  /** Serie y número sueltos del mismo comprobante (los lee el buscador de ventas de Guías). */
  serie?: string;
  numero?: number;
  comprobante_tipo?: number | null;
  comprobante_estado_sunat?: EstadoSunat | null;
  cantidad_notas: number;
  cantidad_guias: number;
}
