import type { EstadoEnvioGre } from '../../sunat/gre/gre.tipos';
import type { EstadoGuia } from './guia-remision.request';

/**
 * Respuestas de /guia-remision. Los bloques del detalle tienen la misma forma que el cuerpo de
 * POST/PUT (destinatario, partida, llegada, transportista, vehiculo, conductor, items): el formulario
 * carga una guía y la vuelve a enviar tal cual.
 */

/** Archivos descargables del último envío a SUNAT (GET /guia-remision/:id/archivos/:tipo). */
export const TIPOS_ARCHIVO_GUIA = ['xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'] as const;
export type TipoArchivoGuia = (typeof TIPOS_ARCHIVO_GUIA)[number];

/** Qué se puede hacer con la guía en su estado actual (la emisión además exige GET /guia-remision/modo activo). */
export interface AccionesGuiaResponse {
  puede_editar: boolean;
  puede_validar: boolean;
  /** Emitir, reenviar con el mismo número (rechazada) o reintentar el mismo archivo (envío incierto). */
  puede_emitir: boolean;
  puede_consultar: boolean;
  puede_anular: boolean;
}

export interface DocumentoRelacionadoGuiaResponse {
  id_comprobante: number;
  /** Catálogo 61: '01' factura, '03' boleta de venta. */
  tipo: string;
  tipo_texto: string;
  serie: string;
  numero: number;
  /** «F001-00000123». */
  numero_formateado: string;
}

export interface PuntoGuiaResponse {
  ubigeo: string | null;
  /** «150119 - LURIN - LIMA - LIMA» (o el código solo si no está en el catálogo INEI). */
  ubigeo_texto: string | null;
  direccion: string | null;
  codigo_establecimiento: string | null;
}

export interface DestinatarioGuiaResponse {
  tipo_documento: string | null;
  numero_documento: string | null;
  denominacion: string | null;
  direccion: string | null;
}

export interface TransportistaGuiaResponse {
  ruc: string | null;
  razon_social: string | null;
  registro_mtc: string | null;
}

export interface VehiculoGuiaResponse {
  placa: string | null;
  tarjeta_circulacion: string | null;
  marca: string | null;
}

export interface ConductorGuiaResponse {
  tipo_documento: string | null;
  numero_documento: string | null;
  nombres: string | null;
  apellidos: string | null;
  licencia: string | null;
}

export interface GuiaRemisionItemResponse {
  id_item: number;
  id_producto: number;
  id_venta_detalle: number | null;
  codigo: string | null;
  descripcion: string;
  /** Catálogo 03 (NIU, KGM…). */
  unidad: string;
  cantidad: number;
  orden: number;
}

/** Último envío a SUNAT de la guía (fiscal_envios). */
export interface EnvioGuiaResponse {
  id_envio: number;
  /** ENVIANDO, TICKET_PENDIENTE, PENDIENTE_REENVIO, ACEPTADO, ACEPTADO_OBS, RECHAZADO o ERROR_CONFIG. */
  estado: string;
  codigo: string | null;
  mensaje: string | null;
  intento: number;
  /** Consultas del ticket hechas (manuales y automáticas). */
  consultas: number;
  /** Otro proceso lo está enviando o consultando ahora mismo. */
  en_curso: boolean;
  /** La consulta automática se detuvo (constancia que no corresponde o demasiados intentos): consulte a mano. */
  revision_manual: boolean;
  proximo_intento_en: string | null;
  actualizado_en: string | null;
}

export interface SunatGuiaResponse {
  ticket: string | null;
  codigo: string | null;
  descripcion: string | null;
  /** Enlace del QR que devuelve SUNAT en la constancia (solo aceptada). */
  cadena_qr: string | null;
  codigo_hash: string | null;
}

export interface GuiaRemisionResumenResponse {
  id_guia: number;
  id_venta: number | null;
  id_comprobante: number | null;
  serie: string | null;
  numero: number | null;
  /** «T001-00000001»; null mientras es borrador (el número se asigna al emitir). */
  numero_formateado: string | null;
  estado: EstadoGuia;
  estado_texto: string;
  /** Guías anteriores al sistema actual (estado legacy): solo lectura. */
  solo_lectura: boolean;
  fecha_emision: string | null;
  fecha_inicio_traslado: string | null;
  motivo_traslado: string | null;
  motivo_traslado_texto: string | null;
  modalidad_traslado: string | null;
  modalidad_traslado_texto: string | null;
  destinatario: DestinatarioGuiaResponse;
  llegada: PuntoGuiaResponse;
  documento_relacionado: DocumentoRelacionadoGuiaResponse | null;
  sunat_ticket: string | null;
  error_mensaje: string | null;
  creado_en: string | null;
  acciones: AccionesGuiaResponse;
}

export interface GuiaRemisionResponse extends GuiaRemisionResumenResponse {
  /** HH:mm:ss de Lima con la que se firmó (null en borrador). */
  hora_emision: string | null;
  descripcion_motivo: string | null;
  fecha_entrega_transportista: string | null;
  peso_bruto_total: number | null;
  unidad_peso: string | null;
  numero_bultos: number | null;
  partida: PuntoGuiaResponse;
  transportista: TransportistaGuiaResponse | null;
  vehiculo: VehiculoGuiaResponse | null;
  conductor: ConductorGuiaResponse | null;
  items: GuiaRemisionItemResponse[];
  observaciones: string | null;
  sunat: SunatGuiaResponse;
  envio: EnvioGuiaResponse | null;
  archivos: TipoArchivoGuia[];
  anulacion: { motivo: string | null; fecha: string } | null;
  avisos: string[];
}

export interface ListadoGuiasRemisionResponse {
  datos: GuiaRemisionResumenResponse[];
  total: number;
  pagina: number;
  por_pagina: number;
}

/** Un mensaje de validación con el campo del motor (`campo`) y el del formulario (`campo_formulario`). */
export interface ObservacionGuiaResponse {
  campo: string;
  campo_formulario: string;
  nivel: 'error' | 'advertencia';
  mensaje: string;
}

export interface ValidacionGuiaResponse {
  valido: boolean;
  errores: string[];
  advertencias: string[];
  por_campo: ObservacionGuiaResponse[];
}

/**
 * Resultado de emitir o consultar el ticket, junto con la guía ya actualizada. Al emitir, si SUNAT dio
 * ticket se consulta una vez enseguida: `resultado` es entonces ACEPTADA o RECHAZADA (con el motivo en
 * `mensaje` y `errores`) o, si SUNAT aún la procesa, TICKET_PENDIENTE con la guía en 'enviado'.
 */
export interface OperacionGuiaResponse {
  guia: GuiaRemisionResponse;
  resultado: {
    estado: EstadoEnvioGre;
    codigo: string | null;
    mensaje: string;
    ticket: string | null;
    errores: Array<{ codigo: string; descripcion: string }>;
  };
}

export interface ItemContextoVentaGuiaResponse {
  id_producto: number;
  id_venta_detalle: number;
  codigo: string | null;
  descripcion: string;
  unidad: string;
  cantidad_vendida: number;
  /** Suma de las guías vigentes de la venta (no anuladas ni rechazadas). */
  cantidad_en_guias: number;
  cantidad_pendiente: number;
}

/** GET /guia-remision/ventas/:id/contexto: lo que precarga el formulario de una guía de venta. */
export interface ContextoVentaGuiaResponse {
  venta: {
    id_venta: number;
    fecha: string | null;
    total: number;
    estado: string;
    id_cliente: number | null;
    id_empresa: number | null;
  };
  /** false si la venta está anulada o ya no tiene cantidades pendientes de guía. */
  permitido: boolean;
  motivo_no_permitido: string | null;
  destinatario: DestinatarioGuiaResponse;
  documento_relacionado: DocumentoRelacionadoGuiaResponse | null;
  partida: PuntoGuiaResponse;
  llegada: PuntoGuiaResponse;
  almacen: { id_almacen: number; nombre: string | null; direccion: string | null } | null;
  items: ItemContextoVentaGuiaResponse[];
  guias: Array<{ id_guia: number; numero_formateado: string | null; estado: EstadoGuia; estado_texto: string }>;
  avisos: string[];
}

export interface OpcionCatalogoGuia {
  codigo: string;
  nombre: string;
}

export interface CatalogosGuiaResponse {
  motivos: Array<OpcionCatalogoGuia & { descripcion: string; requiere_venta: boolean; requiere_descripcion: boolean; requiere_establecimiento: boolean }>;
  modalidades: Array<OpcionCatalogoGuia & { descripcion: string }>;
  unidades_peso: OpcionCatalogoGuia[];
  tipos_documento_destinatario: OpcionCatalogoGuia[];
  tipos_documento_conductor: OpcionCatalogoGuia[];
  unidades_medida: OpcionCatalogoGuia[];
  documentos_relacionados: OpcionCatalogoGuia[];
  estados: OpcionCatalogoGuia[];
  ubigeo: { minimo_caracteres: number; maximo_resultados: number };
  /** Hoy en Lima (aaaa-mm-dd): fecha de emisión y mínimo del inicio del traslado. */
  hoy: string;
}
