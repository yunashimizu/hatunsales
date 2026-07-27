import { ReceptorResponse } from '../receptor.response';

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
  cadena_qr?: string;
  codigo_hash?: string;
  anulado?: boolean;
  estado?: string;
  error?: string;
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
  puede_anular: boolean;
}

export interface ItemPreviewResponse {
  id_producto?: number;
  codigo: string;
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
  /** Avisos no bloqueantes, por ejemplo un RUC no habido. */
  advertencias: string[];
  /** Cuerpo exacto que se enviaría a NUBEFACT. Útil para depurar rechazos. */
  json_nubefact: Record<string, any>;
}
