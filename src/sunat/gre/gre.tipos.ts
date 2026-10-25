import type { EmisorCpe } from '../nucleo/documento-fiscal.types';

/**
 * Tipos de la Guía de Remisión Electrónica REMITENTE (catálogo 01: tipo '09').
 *
 * Los comparten el motor SUNAT (src/sunat/gre: validaciones, XML DespatchAdvice, firma, ZIP, API REST) y
 * el negocio (guía en BD, formulario, enlace con la venta). Se pueden AGREGAR campos opcionales o
 * corregir catálogos con la guía oficial de SUNAT, pero no renombrar ni quitar campos existentes sin avisar.
 *
 * Fuente de campos, longitudes y catálogos: RS 000123-2022/SUNAT (anexo N.° 8 catálogos, anexo N.° 12
 * requisitos y validaciones, anexo N.° 14 estándar UBL 2.1), con los cambios de la RS 000240-2024/SUNAT
 * (catálogos 20 y 61) y de la RS 000108-2026/SUNAT (vigente desde el 01/06/2026).
 */

/** Catálogo 06 (tipo de documento de identidad): '1' DNI, '4' carné de extranjería, '6' RUC, '7' pasaporte, '0' doc. tributario de no domiciliado sin RUC… */
export interface PersonaGre {
  tipoDoc: string;
  numDoc: string;
  /** Razón social o nombres y apellidos (hasta 250 caracteres). */
  nombre: string;
}

export interface DireccionGre {
  /** Ubigeo INEI de 6 dígitos del punto (distrito, catálogo 13). */
  ubigeo: string;
  /** Dirección completa del punto (hasta 500 caracteres). */
  direccion: string;
  /**
   * Código de establecimiento anexo registrado en SUNAT ('0000' = domicilio fiscal). Obligatorio con el
   * motivo 04 (anexo N.° 12, campos 35 y 38); con los demás motivos no viaja en el XML.
   */
  codigoEstablecimiento?: string;
}

/**
 * Catálogo 20 (motivo de traslado, texto de la RS 000240-2024): '01' venta, '02' compra, '03' venta con
 * entrega a terceros, '04' traslado entre establecimientos de la misma empresa, '05' consignación,
 * '06' devolución, '07' recojo de bienes transformados, '08' importación, '09' exportación, '13' otros,
 * '14' venta sujeta a confirmación del comprador, '17' traslado de bienes para transformación,
 * '18' traslado por emisor itinerante, '19' traslado de mercancía extranjera.
 * El motor solo emite 01, 04 y 13 (MOTIVOS_GRE_SOPORTADOS); los demás se rechazan al validar.
 */
export type MotivoTrasladoGre = string;

/** Catálogo 18 (modalidad de traslado): '01' transporte público (lo hace un transportista con RUC), '02' transporte privado (vehículo y conductor propios). */
export type ModalidadTransporteGre = '01' | '02';

export interface TransportistaGre {
  /** Siempre RUC ('6'): quien presta el transporte público. */
  tipoDoc: string;
  numDoc: string;
  razonSocial: string;
  /** Registro MTC del transportista (hasta 20 caracteres), si la normativa lo exige para el tipo de carga. */
  registroMtc?: string;
}

export interface VehiculoGre {
  /** Placa sin guiones ni espacios, en mayúsculas (6 a 8 caracteres). */
  placa: string;
  /** Tarjeta Única de Circulación o Certificado de Habilitación Vehicular Especial del MTC (hasta 15 caracteres). */
  tarjetaCirculacion?: string;
}

export interface ConductorGre {
  tipoDoc: string;
  numDoc: string;
  nombres: string;
  apellidos: string;
  /** Número de licencia de conducir (hasta 10 caracteres). */
  licencia: string;
}

export interface ItemGre {
  cantidad: number;
  /** Unidad del catálogo 03 (UN/ECE rec 20): NIU, KGM, MTR, BX… */
  unidad: string;
  /** Nombre y características (marca; número de serie o motor si es un bien identificable). Hasta 500 caracteres. */
  descripcion: string;
  /** Código interno del producto (hasta 30 caracteres). */
  codigoInterno?: string;
  /** Código de producto SUNAT (UNSPSC, catálogo 25) de 8 dígitos. */
  codigoSunat?: string;
}

/** Documento que sustenta el traslado (factura, boleta…): catálogo 61 (documentos relacionados a la GRE, versión 2.0). */
export interface DocumentoRelacionadoGre {
  /** '01' factura, '03' boleta de venta, '04' liquidación de compra, '09' guía remitente, '12' ticket, '31' guía transportista, '50' DAM… */
  tipo: string;
  serie: string;
  numero: string;
  /**
   * RUC de quien emitió el documento (cac:IssuerParty). Por omisión, el del remitente; solo viaja en
   * comprobantes y guías (tipos 01, 03, 04, 09, 12, 31 y 48).
   */
  rucEmisor?: string;
}

export interface EnvioGre {
  motivo: MotivoTrasladoGre;
  /** Texto libre del motivo (obligatorio cuando el motivo es 'otros'; hasta 100 caracteres). */
  descripcionMotivo?: string;
  modalidad: ModalidadTransporteGre;
  /** yyyy-mm-dd; no puede ser anterior a la fecha de emisión. */
  fechaInicioTraslado: string;
  /**
   * Solo transporte público: fecha de entrega de los bienes al transportista (yyyy-mm-dd, campo 39-A de la
   * RS 000108-2026). Si no llega se usa la fecha de inicio del traslado.
   */
  fechaEntregaTransportista?: string;
  pesoBrutoTotal: number;
  /** 'KGM' (kilogramo) o 'TNE' (tonelada). */
  unidadPeso: string;
  numeroBultos?: number;
  partida: DireccionGre;
  llegada: DireccionGre;
}

export interface DocumentoGre {
  tipo: '09';
  /** T + 3 caracteres alfanuméricos (p. ej. T001). */
  serie: string;
  numero: number;
  /** yyyy-mm-dd, hora de Lima. */
  fechaEmision: string;
  /** HH:mm:ss */
  horaEmision: string;
  remitente: EmisorCpe;
  destinatario: PersonaGre;
  envio: EnvioGre;
  /** Obligatorio con modalidad '01' (transporte público). */
  transportista?: TransportistaGre;
  /** Obligatorios con modalidad '02' (transporte privado). */
  vehiculo?: VehiculoGre;
  /** El primero es el conductor principal; hasta 2 secundarios. */
  conductores?: ConductorGre[];
  items: ItemGre[];
  documentosRelacionados?: DocumentoRelacionadoGre[];
  /** Hasta 250 caracteres. */
  observaciones?: string;
}

/** Un mensaje de validación atado al campo del DocumentoGre que lo provoca (para marcarlo en el formulario). */
export interface ObservacionCampoGre {
  /** Ruta del campo: 'envio.partida.ubigeo', 'items[0].cantidad', 'conductores[1].licencia'… */
  campo: string;
  nivel: 'error' | 'advertencia';
  mensaje: string;
}

export interface ResultadoValidacionGre {
  errores: string[];
  advertencias: string[];
  /** Los mismos mensajes con el campo al que se refieren. */
  porCampo?: ObservacionCampoGre[];
}

/** Estado del envío de una GRE a SUNAT (el negocio lo traduce al estado de la guía). */
export type EstadoEnvioGre =
  /** SUNAT recibió el ZIP y dio un ticket (o la consulta dijo «en proceso»): consultar más tarde. */
  | 'TICKET_PENDIENTE'
  | 'ACEPTADA'
  | 'RECHAZADA'
  /** Credenciales, permisos o configuración del emisor: corregir y reintentar (no es culpa del documento). */
  | 'ERROR_CONFIG'
  /** Resultado incierto (red, 5xx): se puede reenviar el MISMO ZIP con seguridad. */
  | 'PENDIENTE_REENVIO';

export type AccionGre = 'NINGUNA' | 'CONSULTAR_TICKET' | 'REINTENTAR' | 'REVISAR_CONFIG' | 'CORREGIR_Y_REENVIAR';

export interface ErrorSunatGre {
  codigo: string;
  descripcion: string;
}
