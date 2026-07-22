export class ComprobanteResponse {
  id_comprobante?: number;
  tipo_de_comprobante!: number;
  serie!: string;
  numero!: number;
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
  error?: string;
}

export class AnulacionResponse {
  numero!: number;
  enlace?: string;
  sunat_ticket?: string;
  aceptada_sunat?: boolean;
  sunat_description?: string;
  enlace_pdf?: string;
  enlace_xml?: string;
  enlace_cdr?: string;
}