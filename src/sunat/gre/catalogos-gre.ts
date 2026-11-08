import type { ModalidadTransporteGre } from './gre.tipos';

/**
 * Catálogos y valores fijos de la GRE remitente.
 * Fuentes oficiales: RS 000123-2022/SUNAT (anexo N.° 8 y anexo N.° 14), RS 000240-2024/SUNAT (catálogos 20
 * y 61) y RS 000108-2026/SUNAT (catálogo 61 y anexo N.° 14, vigente desde el 01/06/2026).
 */

export const TIPO_DOCUMENTO_GRE_REMITENTE = '09';

/** Catálogo 20: motivo de traslado (texto de la RS 000240-2024, que agrega el 19). */
export const CATALOGO_20_MOTIVOS_TRASLADO: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Venta',
  '02': 'Compra',
  '03': 'Venta con entrega a terceros',
  '04': 'Traslado entre establecimientos de la misma empresa',
  '05': 'Consignación',
  '06': 'Devolución',
  '07': 'Recojo de bienes transformados',
  '08': 'Importación',
  '09': 'Exportación',
  '13': 'Otros',
  '14': 'Venta sujeta a confirmación del comprador',
  '17': 'Traslado de bienes para transformación',
  '18': 'Traslado por emisor itinerante de comprobantes de pago',
  '19': 'Traslado de mercancía extranjera',
});

/**
 * Motivos que el motor sabe emitir: 01 venta, 02 compra (con los datos del proveedor), 04 traslado entre
 * establecimientos, 13 otros, 14 venta sujeta a confirmación del comprador y 18 traslado por emisor itinerante.
 * Los demás piden datos que el sistema todavía no captura (comprador en 03, recojo en 07, DAM, contenedores
 * y precintos en 08/09/19…).
 * [SUPUESTO: 02, 14 y 18 se agregaron según el catálogo 20 sin una guía real de SUNAT que los confirme; el 02 asume
 * que el destinatario es el propio remitente y que el proveedor va en cac:SellerSupplierParty. Confirmar con la primera
 * guía real de cada motivo.]
 */
export const MOTIVOS_GRE_SOPORTADOS: readonly string[] = Object.freeze(['01', '02', '04', '13', '14', '18']);

export const MOTIVO_GRE_VENTA = '01';
export const MOTIVO_GRE_COMPRA = '02';
export const MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS = '04';
export const MOTIVO_GRE_OTROS = '13';
export const MOTIVO_GRE_VENTA_CONFIRMACION = '14';
export const MOTIVO_GRE_EMISOR_ITINERANTE = '18';

/** Motivos que salen de una venta registrada (la guía lleva lo vendido): el 01 y el 14. */
export const MOTIVOS_GRE_CON_VENTA: readonly string[] = Object.freeze(['01', '14']);
/** Motivos en que el destinatario es el propio remitente (los bienes llegan a su establecimiento). */
export const MOTIVOS_GRE_DESTINATARIO_PROPIO: readonly string[] = Object.freeze(['02', '04']);

/**
 * Indicador de traslado en vehículos de categoría M1 o L (motos y autos particulares): va como
 * cbc:SpecialInstructions de cac:Shipment y, cuando se marca, no se consignan vehículo ni conductores.
 * [SUPUESTO: nombre confirmado en la documentación de integradores (versión 1.6 del 01/12/2023); la posición exacta
 * en el XML (SpecialInstructions entre TotalTransportHandlingUnitQuantity y ShipmentStage) sigue el orden del XSD UBL 2.1
 * y se confirma con la primera guía real.]
 */
export const INDICADOR_TRASLADO_VEHICULO_M1L = 'SUNAT_Envio_IndicadorTrasladoVehiculoM1L';

/** Días máximos entre la emisión y el inicio del traslado; desde AVISO se advierte. [SUPUESTO: criterio del proyecto, no un plazo de SUNAT.] */
export const MAXIMO_DIAS_INICIO_TRASLADO = 30;
export const AVISO_DIAS_INICIO_TRASLADO = 7;

/** Catálogo 18: modalidad de traslado. */
export const CATALOGO_18_MODALIDAD_TRASLADO: Readonly<Record<ModalidadTransporteGre, string>> = Object.freeze({
  '01': 'Transporte público',
  '02': 'Transporte privado',
});

/** Catálogo 61: documentos relacionados aplicables a la GRE, versión 2.0 (texto de la RS 000108-2026). */
export const CATALOGO_61_DOCUMENTOS_RELACIONADOS: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Factura',
  '03': 'Boleta de Venta',
  '04': 'Liquidación de Compra',
  '09': 'Guía de Remisión Remitente',
  '12': 'Ticket o cinta emitido por máquina registradora',
  '31': 'Guía de Remisión Transportista',
  '48': 'Comprobante de Operaciones – Ley N° 29972',
  '49': 'Constancia de Depósito - IVAP (Ley 28211)',
  '50': 'Declaración Aduanera de Mercancías (DAM)',
  '52': 'Declaración Simplificada (DS)',
  '80': 'Constancia de Depósito – Detracción',
  '81': 'Código de autorización emitida por el SCOP',
  '82': 'Declaración jurada de mudanza',
  '91': 'Manifiesto de Carga (MC)',
  '92': 'Número de Cita/Orden Entrega Mercancías del Terminal Portuario',
  '93': 'Documento ZOFRATACNA',
  '94': 'Solicitud de Traslado - ZED',
  '95': 'Solicitud de Traslado - ZOFRATACNA',
});

/** Comprobantes y guías: los emite un RUC y llevan su número de serie y correlativo (van con cac:IssuerParty). */
export const DOCUMENTOS_RELACIONADOS_CON_SERIE: ReadonlySet<string> = new Set(['01', '03', '04', '09', '12', '31', '48']);

/** Unidad del peso bruto total (anexo N.° 12, campo 23). */
export const UNIDADES_PESO_GRE: Readonly<Record<string, string>> = Object.freeze({
  KGM: 'Kilogramos',
  TNE: 'Toneladas',
});

/** cac:Shipment/cbc:ID fijo (anexo N.° 14, dato 21). */
export const ID_ENVIO_GRE = 'SUNAT_Envio';

/** cac:DriverPerson/cbc:JobTitle (anexo N.° 14, datos 52 y 56). */
export const TIPO_CONDUCTOR_PRINCIPAL = 'Principal';
export const TIPO_CONDUCTOR_SECUNDARIO = 'Secundario';

/** Un conductor principal y hasta dos secundarios (anexo N.° 14: «incremental hasta 2»). */
export const MAXIMO_CONDUCTORES_GRE = 3;

/** cac:DespatchLine/cbc:ID es n..4 (anexo N.° 14, dato 73). */
export const MAXIMO_ITEMS_GRE = 9999;
