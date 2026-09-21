export interface GuiaRemisionItemResponse {
  id_item?: number;
  id_producto: number;
  id_venta_detalle?: number;
  codigo: string;
  descripcion: string;
  cantidad: number;
  unidad_medida: string;
  orden?: number;
}

export interface GuiaRemisionResponse {
  id_guia?: number;
  id_venta?: number;
  id_comprobante?: number;
  comprobante?: { serie: string; numero: number };
  id_empresa?: number;
  id_cliente?: number;
  tipo_guia: string;
  sunat_tipo_documento?: string;
  serie?: string;
  numero?: number;
  numero_formateado?: string;
  estado: string;
  fecha_emision?: string;
  fecha_inicio_traslado?: string;
  motivo_traslado_codigo?: string;
  modalidad_traslado?: string;
  direccion_origen: string;
  direccion_destino: string;
  origen_ubigeo?: string;
  destino_ubigeo?: string;
  peso_bruto_total?: number;
  unidad_peso?: string;
  numero_bultos?: number;
  destinatario: {
    tipo_documento: string;
    numero_documento: string;
    denominacion: string;
    direccion: string;
  };
  transporte: {
    placa_principal: string;
    marca_vehiculo: string;
    conductor_nombre: string;
    conductor_tipo_doc: string;
    conductor_numero_doc: string;
    conductor_licencia: string;
    transportista_ruc: string;
    transportista_denominacion: string;
  };
  observaciones?: string;
  error_mensaje?: string;
  sunat_description?: string;
  sunat_responsecode?: string;
  sunat_ticket?: string;
  cadena_qr?: string;
  codigo_hash?: string;
  enlace_pdf?: string;
  enlace_xml?: string;
  enlace_cdr?: string;
  creado_en?: Date | string;
  items: GuiaRemisionItemResponse[];
  advertencias?: string[];
}
