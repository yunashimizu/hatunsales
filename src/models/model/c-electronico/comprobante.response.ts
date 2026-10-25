import { ReceptorResponse } from '../receptor.response';

export interface ObservacionSunatResponse {
  codigo: string;
  descripcion: string;
}

export interface ComprobanteResponse {
  id_comprobante?: number;
  tipo_de_comprobante?: number;
  serie?: string;
  numero?: number;
  numero_formateado?: string;
  enlace?: string;
  enlace_pdf?: string;
  enlace_xml?: string;
  enlace_cdr?: string;
  aceptada_sunat?: boolean;
  sunat_description?: string;
  sunat_responsecode?: string;
  sunat_observaciones?: ObservacionSunatResponse[];
  cadena_qr?: string;
  codigo_hash?: string;
  anulado?: boolean;
  /** 'emitido' solo si SUNAT lo aceptó; 'pendiente' mientras el envío sigue en curso; 'error' si no se aceptó. */
  estado?: string;
  error?: string;
  proveedor_fiscal?: string;
  ambiente_fiscal?: string;
  estado_sunat?: string;
  id_envio_ultimo?: number;
  /** Qué hacer a continuación según SUNAT (REINTENTAR, RECUPERAR_CDR, EMITIR_NUEVO…). */
  accion_sunat?: string | null;
  /** Archivos guardados del envío (xml_original, xml_firmado, zip, cdr_xml, cdr_zip). */
  archivos?: string[];
  /** @deprecated Igual que `archivos`; se conserva para el panel anterior. */
  archivos_beta?: string[];
  /** Aviso del ambiente (p. ej. «Prueba SUNAT BETA: sin validez tributaria»). */
  aviso?: string | null;
  /** Último día (yyyy-mm-dd, Lima) para que SUNAT reciba el comprobante por envío individual. */
  fecha_limite_envio?: string | null;
  id_venta?: number | null;
  /** Solo notas: comprobante que modifican. */
  id_comprobante_modificado?: number | null;
  /** Solo notas: 'F001-12'. */
  doc_modificado?: string | null;
}

export interface AnulacionResponse {
  numero?: number;
  enlace?: string;
  sunat_ticket?: string;
  aceptada_sunat?: boolean;
  sunat_description?: string;
  enlace_pdf?: string;
  enlace_xml?: string;
  enlace_cdr?: string;
}

/** Fila del listado de documentos del panel. */
export interface ComprobanteListadoResponse {
  id_comprobante: number;
  id_tipo?: number;
  tipo_nombre: string;
  serie: string;
  numero: number;
  numero_formateado: string;
  fecha_de_emision: string;
  creado_en: Date;
  cliente_numero_doc: string;
  cliente_denominacion: string;
  moneda_simbolo: string;
  total: number;
  estado: string;
  aceptada_sunat: boolean;
  anulado: boolean;
  sunat_description?: string;
  error_mensaje?: string;
  enlace?: string;
  enlace_pdf?: string;
  proveedor_fiscal?: string | null;
  ambiente_fiscal?: string | null;
  estado_sunat?: string | null;
  id_envio_ultimo?: number | null;
  accion_sunat?: string | null;
  id_venta?: number | null;
  id_comprobante_modificado?: number | null;
  doc_modificado?: string | null;
  fecha_limite_envio?: string | null;
  /** Pasó la fecha límite de envío individual sin que SUNAT lo aceptara. */
  vencido?: boolean;
  puede_reintentar?: boolean;
  puede_recuperar_cdr?: boolean;
  /** Solo lo ejecuta un administrador. */
  puede_confirmar_manual?: boolean;
  /** Regla básica (aceptado, del ambiente vigente, no anulado); el saldo lo valida la nota de crédito. */
  puede_nota_credito?: boolean;
  puede_anular: boolean;
}

/** Envío a SUNAT tal como se muestra en el detalle. */
export interface EnvioDetalleResponse {
  id_envio: number;
  estado: string;
  codigo: string | null;
  mensaje: string | null;
  accion: string | null;
  intento: number | null;
}

export interface NotaEnlazadaResponse {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  numero_formateado: string;
  motivo: string | null;
  total: number;
  estado: string;
  estado_sunat: string | null;
  anulado: boolean;
}

export interface GuiaEnlazadaResponse {
  id_guia: number;
  serie: string | null;
  numero: number | null;
  numero_formateado: string | null;
  estado: string | null;
  fecha_emision: string | null;
}

/** Detalle completo de un comprobante (reimpresión, revisión y acciones). */
export interface ComprobanteDetalleResponse {
  emisor: {
    ruc: string;
    razon_social: string;
    nombre_comercial?: string | null;
    direccion: string;
    ubicacion: string;
    logo_url: string;
    telefono?: string | null;
    email?: string | null;
  };
  id_comprobante: number;
  id_tipo?: number;
  tipo_nombre: string;
  serie: string;
  numero: number;
  numero_formateado: string;
  fecha_de_emision: string;
  fecha_de_vencimiento: string;
  hora_emision: string | null;
  moneda: { id_moneda: number; nombre: string; simbolo: string };
  receptor: {
    tipo_documento: number;
    numero_documento: string;
    denominacion: string;
    direccion: string;
    email: string;
  };
  items: {
    codigo: string;
    codigo_producto_sunat?: string | null;
    unidad_de_medida: string;
    descripcion: string;
    cantidad: number;
    valor_unitario: number;
    precio_unitario: number;
    descuento: number;
    subtotal: number;
    igv: number;
    total: number;
    tipo_de_igv?: number;
  }[];
  porcentaje_igv: number;
  totales: {
    gravada: number;
    exonerada: number;
    inafecta: number;
    descuento: number;
    igv: number;
    total: number;
  };
  importe_en_letras: string;
  observaciones: string;
  estado: string;
  anulado: boolean;
  motivo_anulacion: string;
  enlace: string;
  enlace_pdf: string;
  cadena_qr: string | null;
  codigo_hash: string | null;
  sunat_description: string;
  sunat_responsecode?: string | null;
  sunat_observaciones: ObservacionSunatResponse[];
  error_mensaje: string;
  proveedor_fiscal: string | null;
  ambiente_fiscal: string | null;
  estado_sunat: string | null;
  aceptada_sunat: boolean;
  id_envio_ultimo: number | null;
  id_venta: number | null;
  forma_pago: 'Contado' | 'Credito' | null;
  cuotas: { numero: number; monto: number; fecha_pago: string }[];
  fecha_limite_envio: string | null;
  vencido: boolean;
  envio: EnvioDetalleResponse | null;
  /** Solo notas: comprobante que modifican. */
  referencia: {
    id_comprobante: number | null;
    tipo: string;
    serie: string;
    numero: number;
    numero_formateado: string;
    motivo: string | null;
    motivo_descripcion: string | null;
    sustento: string | null;
  } | null;
  notas: NotaEnlazadaResponse[];
  guias: GuiaEnlazadaResponse[];
  archivos: string[];
  aviso: string | null;
  puede_reintentar: boolean;
  puede_recuperar_cdr: boolean;
  puede_confirmar_manual: boolean;
  puede_nota_credito: boolean;
  puede_anular: boolean;
}

export interface ItemPreviewResponse {
  id_producto?: number;
  codigo: string;
  /** Vacío si el producto no tiene código SUNAT y no hay uno por defecto configurado (se omite del XML). */
  codigo_producto_sunat: string;
  unidad_de_medida: string;
  descripcion: string;
  cantidad: number;
  valor_unitario: number;
  precio_unitario: number;
  descuento: number;
  subtotal: number;
  igv: number;
  total: number;
  tipo_de_igv: number;
}

/**
 * Todo lo necesario para dibujar el comprobante antes de emitirlo, con el mismo
 * contenido que tendrá la representación impresa.
 */
export interface PreviewComprobanteResponse {
  emisor: {
    ruc: string;
    razon_social: string;
    direccion: string;
    ubicacion: string;
    logo_url: string;
  };
  id_tipo: number;
  tipo_nombre: string;
  serie: string;
  numero: number;
  numero_formateado: string;
  fecha_de_emision: string;
  fecha_de_vencimiento: string;
  moneda: { id_moneda: number; nombre: string; simbolo: string };
  receptor: ReceptorResponse;
  items: ItemPreviewResponse[];
  porcentaje_igv: number;
  totales: {
    gravada: number;
    exonerada: number;
    inafecta: number;
    descuento: number;
    igv: number;
    total: number;
  };
  importe_en_letras: string;
  observaciones: string;
  nota?: {
    motivo_codigo: string;
    motivo_texto: string;
    documento_modificado: string;
  };
  /** Avisos no bloqueantes, por ejemplo un RUC no habido o la emisión electrónica inactiva. */
  advertencias: string[];
  proveedor_fiscal?: 'sunat_directo';
  ambiente_fiscal?: 'beta' | 'produccion';
  /** false si hoy la venta se registraría sin comprobante (el motivo va en `advertencias`). */
  emision_activa?: boolean;
  /** Aviso del ambiente (p. ej. «Prueba SUNAT BETA: sin validez tributaria»). */
  aviso?: string | null;
  /**
   * Presente solo si algún pago es con tarjeta. El recargo ya está en `items` (línea de
   * servicio) y dentro de `totales.total`; aquí va el desglose para mostrarlo.
   */
  recargo_tarjeta?: {
    porcentaje: number;
    /** Parte de la venta (con IGV, sin recargo) que se cobra con tarjeta. */
    base_tarjeta: number;
    /** Recargo con IGV incluido. */
    monto: number;
    /** Total de los productos antes del recargo. */
    total_sin_recargo: number;
  };
}

/** Motivo de nota del catálogo SUNAT con la forma en que el asistente arma la nota. */
export interface MotivoNotaResponse {
  codigo: string;
  nombre: string;
  /** total: todo el comprobante; items: cantidades por ítem; descuento_items: descuento por línea; monto: ajuste por importe. */
  forma: 'total' | 'items' | 'descuento_items' | 'monto';
  /** Catálogo 01 de los comprobantes que puede modificar ('01' factura, '03' boleta). */
  tipos: ('01' | '03')[];
}

export interface CatalogoMotivosResponse {
  nota_credito: MotivoNotaResponse[];
  nota_debito: MotivoNotaResponse[];
}
