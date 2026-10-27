/**
 * Catalogos oficiales de SUNAT usados por el pipeline "sunat-direct" (envio
 * propio, sin OSE) al construir los XML UBL 2.1 de Factura, Boleta, Nota de
 * Credito, Nota de Debito y Guia de Remision Remitente.
 *
 * Fuentes: Anexo N.8 de la RS 193-2020/SUNAT (catalogo 09 - motivos de nota
 * de credito), RS 000048-2026 (postergada al 01/01/2027 por la RS
 * 000143-2026) y guias oficiales de elaboracion de documentos XML UBL 2.1
 * publicadas en cpe.sunat.gob.pe. No confundir con los catalogos propios de
 * NUBEFACT (ver ../../util/fiscal/nubefact.catalogo.ts) — SUNAT y NUBEFACT
 * numeran distinto.
 */

/** Catalogo 01: tipo de documento (el mismo que ya usa nubefact.catalogo.ts, repetido aqui para no acoplar los dos modulos). */
export const CATALOGO_01_FACTURA = '01';
export const CATALOGO_01_BOLETA = '03';
export const CATALOGO_01_NOTA_CREDITO = '07';
export const CATALOGO_01_NOTA_DEBITO = '08';
export const CATALOGO_01_GUIA_REMISION_REMITENTE = '09';

export const NOMBRE_TIPO_CPE: Readonly<Record<'01' | '03' | '07' | '08', string>> = {
  '01': 'Factura',
  '03': 'Boleta de venta',
  '07': 'Nota de crédito',
  '08': 'Nota de débito',
};

/** Atributos del catálogo 01 en cbc:InvoiceTypeCode (el listID es el tipo de operación, catálogo 51). */
export const ATRIBUTOS_CATALOGO_01 = Object.freeze({
  listAgencyName: 'PE:SUNAT',
  listName: 'Tipo de Documento',
  listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01',
});

/**
 * Tope de la boleta sin identificar al adquirente: el Reglamento de
 * Comprobantes de Pago exige el documento cuando el importe SUPERA S/ 700
 * (igual que TOPE_BOLETA_SIN_DOCUMENTO de receptor.bussnies.ts).
 */
export const TOPE_BOLETA_SIN_DOCUMENTO_SUNAT = 700;

/**
 * Plazos en días calendario contados desde el día siguiente a la emisión:
 * factura y notas F 3 días (RS 000003-2023), boleta individual 5 días y por
 * resumen hasta el 7.º día (RS 114-2019), comunicación de baja 7 días.
 */
export const PLAZOS_ENVIO_DIAS = Object.freeze({
  facturaYNotas: 3,
  boletaIndividual: 5,
  resumenDiario: 7,
  comunicacionBaja: 7,
});

/** Catalogo 06: tipo de documento de identidad del cliente. */
export const CATALOGO_06_DNI = '1';
export const CATALOGO_06_CARNET_EXTRANJERIA = '4';
export const CATALOGO_06_RUC = '6';
export const CATALOGO_06_PASAPORTE = '7';
export const CATALOGO_06_SIN_DOCUMENTO = '0';

/** Todos los códigos del catálogo 06 que SUNAT admite en el adquirente. */
export const CATALOGO_06_TIPOS_VALIDOS: ReadonlySet<string> = new Set(['0', '1', '4', '6', '7', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);

export type TipoDocIdentidadSunat = '0' | '1' | '4' | '6' | '7';

/**
 * Traduce el tipo de documento entero que guarda el sistema (codificación de
 * NUBEFACT: 0, 1, 4, 6, 7) al código del catálogo 06 de SUNAT. Un valor
 * desconocido se trata como "sin documento" ('0'): la validación previa al
 * envío lo rechazará si el comprobante exige documento (factura o boleta > S/ 700).
 */
export function tipoDocIdentidadSunat(nubefact: number | string | null | undefined): TipoDocIdentidadSunat {
  const texto = String(nubefact ?? '').trim();
  switch (texto) {
    case '1':
      return '1';
    case '4':
      return '4';
    case '6':
      return '6';
    case '7':
      return '7';
    default:
      return '0';
  }
}

export type AfectacionIgv = '10' | '20' | '30' | '40';

/**
 * Catalogo 05 (UNECE 5305 "Duty/tax/fee category"): identificador corto que
 * exige SUNAT dentro de cac:TaxCategory/cbc:ID, ademas del
 * cbc:TaxExemptionReasonCode (catalogo 07) que ya se usaba. Sin este ID
 * corto, SUNAT acepta el XML pero lo observa (codigo 4xxx).
 */
export const CATALOGO_05_POR_AFECTACION: Record<AfectacionIgv, 'S' | 'E' | 'O' | 'Z'> = {
  '10': 'S', // Gravado - Operacion Onerosa
  '20': 'E', // Exonerado - Operacion Onerosa
  '30': 'O', // Inafecto - Operacion Onerosa
  '40': 'Z', // Exportacion
};

/** Catalogo 07: tipo de afectacion del IGV (ya usado antes de esta extension). */
export function nombreTaxScheme(afectacion: AfectacionIgv): { id: string; nombre: string; codigo: string } {
  if (afectacion === '10') return { id: '1000', nombre: 'IGV', codigo: 'VAT' };
  if (afectacion === '20') return { id: '9997', nombre: 'EXO', codigo: 'VAT' };
  if (afectacion === '40') return { id: '9995', nombre: 'EXP', codigo: 'FRE' };
  return { id: '9998', nombre: 'INA', codigo: 'FRE' };
}

/**
 * Catálogo 07 completo: tipos de afectación del IGV. El emisor directo solo
 * emite operaciones onerosas (10, 20, 30), que son las que produce
 * calculo-fiscal.ts. Las gratuitas (11-17, 21, 31-36) y la exportación (40)
 * se reconocen para rechazarlas con un mensaje claro antes de enviar.
 */
export const CATALOGO_07_AFECTACION_IGV: Readonly<Record<string, string>> = {
  '10': 'Gravado - Operación Onerosa',
  '11': 'Gravado - Retiro por premio',
  '12': 'Gravado - Retiro por donación',
  '13': 'Gravado - Retiro',
  '14': 'Gravado - Retiro por publicidad',
  '15': 'Gravado - Bonificaciones',
  '16': 'Gravado - Retiro por entrega a trabajadores',
  '17': 'Gravado - IVAP',
  '20': 'Exonerado - Operación Onerosa',
  '21': 'Exonerado - Transferencia gratuita',
  '30': 'Inafecto - Operación Onerosa',
  '31': 'Inafecto - Retiro por bonificación',
  '32': 'Inafecto - Retiro',
  '33': 'Inafecto - Retiro por muestras médicas',
  '34': 'Inafecto - Retiro por convenio colectivo',
  '35': 'Inafecto - Retiro por premio',
  '36': 'Inafecto - Retiro por publicidad',
  '37': 'Inafecto - Transferencia gratuita',
  '40': 'Exportación de bienes o servicios',
};

export const AFECTACIONES_ONEROSAS: ReadonlySet<string> = new Set(['10', '20', '30']);
export const AFECTACIONES_GRATUITAS: ReadonlySet<string> = new Set([
  '11', '12', '13', '14', '15', '16', '17', '21', '31', '32', '33', '34', '35', '36', '37',
]);

export function esAfectacionOnerosa(codigo: string): codigo is '10' | '20' | '30' {
  return AFECTACIONES_ONEROSAS.has(String(codigo ?? '').trim());
}

export function esAfectacionGratuita(codigo: string): boolean {
  return AFECTACIONES_GRATUITAS.has(String(codigo ?? '').trim());
}

/**
 * tipo_de_igv del sistema (codificación de NUBEFACT: 1 gravado, 8 exonerado,
 * 9 inafecto) → catálogo 07 de SUNAT. Igual que calculo-fiscal.ts, cualquier
 * otro valor se trata como gravado.
 */
export function afectacionDesdeTipoIgvNubefact(tipoIgv: number | string | null | undefined): '10' | '20' | '30' {
  const valor = Number(tipoIgv);
  if (valor === 8) return '20';
  if (valor === 9) return '30';
  return '10';
}

/**
 * Catalogo 09: motivos de Nota de Credito electronica.
 * Fuente: Anexo N.8 de la Resolucion de Superintendencia N.193-2020/SUNAT.
 * Los motivos 04, 05, 08 y 13 NO se pueden usar cuando el documento que se
 * modifica es una Boleta de venta (solo aplican a Factura).
 */
export const CATALOGO_09_MOTIVO_NOTA_CREDITO = {
  ANULACION_DE_LA_OPERACION: '01',
  ANULACION_POR_ERROR_EN_EL_RUC: '02',
  CORRECCION_POR_ERROR_EN_LA_DESCRIPCION: '03',
  DESCUENTO_GLOBAL: '04',
  DESCUENTO_POR_ITEM: '05',
  DEVOLUCION_TOTAL: '06',
  DEVOLUCION_POR_ITEM: '07',
  BONIFICACION: '08',
  DISMINUCION_EN_EL_VALOR: '09',
  OTROS_CONCEPTOS: '10',
  AJUSTES_DE_OPERACIONES_DE_EXPORTACION: '11',
  AJUSTES_AFECTOS_AL_IVAP: '12',
  CORRECCION_MONTO_O_FECHAS_DE_PAGO: '13',
} as const;

export type MotivoNotaCredito = typeof CATALOGO_09_MOTIVO_NOTA_CREDITO[keyof typeof CATALOGO_09_MOTIVO_NOTA_CREDITO];

export const ETIQUETA_MOTIVO_NOTA_CREDITO: Readonly<Record<MotivoNotaCredito, string>> = {
  '01': 'ANULACION DE LA OPERACION',
  '02': 'ANULACION POR ERROR EN EL RUC',
  '03': 'CORRECCION POR ERROR EN LA DESCRIPCION',
  '04': 'DESCUENTO GLOBAL',
  '05': 'DESCUENTO POR ITEM',
  '06': 'DEVOLUCION TOTAL',
  '07': 'DEVOLUCION POR ITEM',
  '08': 'BONIFICACION',
  '09': 'DISMINUCION EN EL VALOR',
  '10': 'OTROS CONCEPTOS',
  '11': 'AJUSTES DE OPERACIONES DE EXPORTACION',
  '12': 'AJUSTES AFECTOS AL IVAP',
  '13': 'CORRECCION DEL MONTO NETO PENDIENTE DE PAGO Y/O FECHAS DE VENCIMIENTO',
};

/** Motivos del catalogo 09 exclusivos de Factura: SUNAT los rechaza si el documento modificado es una Boleta. */
const MOTIVOS_SOLO_FACTURA: MotivoNotaCredito[] = [
  CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_GLOBAL,
  CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_POR_ITEM,
  CATALOGO_09_MOTIVO_NOTA_CREDITO.BONIFICACION,
  CATALOGO_09_MOTIVO_NOTA_CREDITO.CORRECCION_MONTO_O_FECHAS_DE_PAGO,
];

export function esMotivoNotaCredito(motivo: string): motivo is MotivoNotaCredito {
  return Object.prototype.hasOwnProperty.call(ETIQUETA_MOTIVO_NOTA_CREDITO, motivo);
}

export function motivoNotaCreditoValidoParaTipo(motivo: string, tipoDocumentoModificado: '01' | '03'): boolean {
  if (tipoDocumentoModificado === '01') return true;
  return !MOTIVOS_SOLO_FACTURA.includes(motivo as MotivoNotaCredito);
}

/** Fecha desde la que rigen las validaciones de la RS 000048-2026 (postergadas por la RS 000143-2026). */
export const FECHA_VIGENCIA_REGLAS_2027 = '2027-01-01';

/** true si en `fecha` (yyyy-mm-dd) ya rigen las reglas de la RS 000048-2026. */
export function reglas2027Vigentes(fecha: string): boolean {
  return fecha >= FECHA_VIGENCIA_REGLAS_2027;
}

/**
 * Catalogo 10: motivos de Nota de Debito. Desde el 01/01/2027 (RS 000048-2026)
 * el '03' pasa a ser solo "otros conceptos" y las penalidades usan el nuevo
 * '13', que debe ser inafecto.
 */
export const CATALOGO_10_MOTIVO_NOTA_DEBITO = {
  INTERESES_MORA: '01',
  AUMENTO_VALOR: '02',
  OTROS_CONCEPTOS: '03',
  PENALIDADES: '13',
} as const;

export type MotivoNotaDebito = typeof CATALOGO_10_MOTIVO_NOTA_DEBITO[keyof typeof CATALOGO_10_MOTIVO_NOTA_DEBITO];

export function esMotivoNotaDebito(motivo: string): motivo is MotivoNotaDebito {
  return (Object.values(CATALOGO_10_MOTIVO_NOTA_DEBITO) as string[]).includes(motivo);
}

/** El '13' (penalidades) solo existe desde la vigencia de las reglas 2027. */
export function motivoNotaDebitoVigente(motivo: string, fecha: string): boolean {
  if (!esMotivoNotaDebito(motivo)) return false;
  return motivo !== CATALOGO_10_MOTIVO_NOTA_DEBITO.PENALIDADES || reglas2027Vigentes(fecha);
}

/** Etiqueta del motivo de nota de débito según la fecha (el '03' cambia de nombre en 2027). */
export function etiquetaMotivoNotaDebito(motivo: string, fecha: string): string {
  switch (motivo) {
    case CATALOGO_10_MOTIVO_NOTA_DEBITO.INTERESES_MORA:
      return 'INTERESES POR MORA';
    case CATALOGO_10_MOTIVO_NOTA_DEBITO.AUMENTO_VALOR:
      return 'AUMENTO EN EL VALOR';
    case CATALOGO_10_MOTIVO_NOTA_DEBITO.OTROS_CONCEPTOS:
      return reglas2027Vigentes(fecha) ? 'OTROS CONCEPTOS' : 'PENALIDADES / OTROS CONCEPTOS';
    case CATALOGO_10_MOTIVO_NOTA_DEBITO.PENALIDADES:
      return 'PENALIDADES';
    default:
      return 'MOTIVO DESCONOCIDO';
  }
}

/** Catálogo 51: tipo de operación. HatunSales solo hace venta interna. */
export const CATALOGO_51_VENTA_INTERNA = '0101';
/** Catálogo 52: leyenda "monto expresado en letras". */
export const CATALOGO_52_MONTO_EN_LETRAS = '1000';
/** Catálogo 53: descuento que afecta la base imponible del IGV. */
export const CATALOGO_53_DESCUENTO_AFECTA_BASE = '00';

/**
 * Catálogo 03 (UN/ECE rec 20): unidades de medida que acepta el núcleo.
 * SUNAT admite toda la rec 20; esta lista blanca cubre lo que vende una
 * ferretería y evita que una unidad mal escrita en productos llegue al XML.
 */
export const UNIDADES_CATALOGO_03: Readonly<Record<string, string>> = {
  NIU: 'UNIDAD (BIENES)',
  ZZ: 'UNIDAD (SERVICIOS)',
  C62: 'UNO (PIEZA)',
  KGM: 'KILOGRAMO',
  GRM: 'GRAMO',
  MGM: 'MILIGRAMO',
  TNE: 'TONELADA',
  STN: 'TONELADA CORTA',
  LTN: 'TONELADA LARGA',
  LBR: 'LIBRA',
  ONZ: 'ONZA',
  MTR: 'METRO',
  CMT: 'CENTIMETRO',
  MMT: 'MILIMETRO',
  KTM: 'KILOMETRO',
  INH: 'PULGADA',
  FOT: 'PIE',
  YRD: 'YARDA',
  MTK: 'METRO CUADRADO',
  CMK: 'CENTIMETRO CUADRADO',
  MMK: 'MILIMETRO CUADRADO',
  FTK: 'PIE CUADRADO',
  YDK: 'YARDA CUADRADA',
  MTQ: 'METRO CUBICO',
  CMQ: 'CENTIMETRO CUBICO',
  MMQ: 'MILIMETRO CUBICO',
  FTQ: 'PIE CUBICO',
  LTR: 'LITRO',
  MLT: 'MILILITRO',
  HLT: 'HECTOLITRO',
  GLL: 'GALON (US)',
  GLI: 'GALON (UK)',
  BLL: 'BARRIL (US)',
  BX: 'CAJA',
  PK: 'PAQUETE',
  SET: 'JUEGO',
  KT: 'KIT',
  PR: 'PAR',
  DZN: 'DOCENA',
  DZP: 'DOCENA DE PAQUETES',
  CEN: 'CIENTO DE UNIDADES',
  MIL: 'MILLAR',
  // Código de millares de la lista histórica de SUNAT; se acepta si ya está cargado en productos.
  MLL: 'MILLARES',
  UM: 'MILLON DE UNIDADES',
  GRO: 'GRUESA',
  BG: 'BOLSA',
  BO: 'BOTELLA',
  RO: 'ROLLO',
  '4A': 'BOBINA',
  BJ: 'BALDE',
  BE: 'FARDO',
  CA: 'LATA',
  CT: 'CARTON',
  CY: 'CILINDRO',
  DR: 'TAMBOR',
  JR: 'FRASCO',
  PG: 'PLACA',
  PL: 'CUBETA',
  PF: 'PALETA',
  TU: 'TUBO',
  ST: 'PLIEGO',
  LEF: 'HOJA',
  RM: 'RESMA',
  CJ: 'CONO',
  KWH: 'KILOVATIO HORA',
  MWH: 'MEGAVATIO HORA',
  // Ferretería, gasfitería y construcción (UN/ECE rec 20). Bloque aislado: si la boleta de
  // prueba en BETA rechaza alguno, se quita de aquí y de unidades-amigables.ts.
  SA: 'SACO',
  RD: 'VARILLA',
  BR: 'BARRA',
  SR: 'TIRA',
  BD: 'TABLA',
  CO: 'BIDON',
  QT: 'CUARTO DE GALON',
  PT: 'PINTA',
  HUR: 'HORA',
  DAY: 'DIA',
};

/** Sinónimos con los que suelen cargarse las unidades en el sistema. */
export const ALIAS_UNIDADES: Readonly<Record<string, string>> = {
  UND: 'NIU', UNID: 'NIU', UNIDAD: 'NIU', UNIDADES: 'NIU', UN: 'NIU', U: 'NIU', UNI: 'NIU', PZA: 'NIU', PIEZA: 'NIU', PIEZAS: 'NIU',
  SERVICIO: 'ZZ', SERV: 'ZZ', SERVICIOS: 'ZZ',
  KG: 'KGM', KGS: 'KGM', KILO: 'KGM', KILOS: 'KGM', KILOGRAMO: 'KGM', KILOGRAMOS: 'KGM',
  G: 'GRM', GR: 'GRM', GRS: 'GRM', GRAMO: 'GRM', GRAMOS: 'GRM',
  MG: 'MGM', TN: 'TNE', TON: 'TNE', TONELADA: 'TNE', TONELADAS: 'TNE',
  LB: 'LBR', LIBRA: 'LBR', LIBRAS: 'LBR', OZ: 'ONZ', ONZA: 'ONZ', ONZAS: 'ONZ',
  M: 'MTR', MT: 'MTR', MTS: 'MTR', METRO: 'MTR', METROS: 'MTR',
  CM: 'CMT', CENTIMETRO: 'CMT', CENTIMETROS: 'CMT', MM: 'MMT', MILIMETRO: 'MMT', MILIMETROS: 'MMT', KM: 'KTM',
  PULG: 'INH', PULGADA: 'INH', PULGADAS: 'INH', PIE: 'FOT', PIES: 'FOT', YARDA: 'YRD', YARDAS: 'YRD',
  M2: 'MTK', MT2: 'MTK', 'METRO CUADRADO': 'MTK', M3: 'MTQ', MT3: 'MTQ', 'METRO CUBICO': 'MTQ',
  L: 'LTR', LT: 'LTR', LTS: 'LTR', LITRO: 'LTR', LITROS: 'LTR', ML: 'MLT', MILILITRO: 'MLT', MILILITROS: 'MLT',
  GL: 'GLL', GLN: 'GLL', GAL: 'GLL', GALON: 'GLL', GALONES: 'GLL',
  CAJA: 'BX', CAJAS: 'BX', CJA: 'BX', PAQUETE: 'PK', PAQUETES: 'PK', PQT: 'PK', PAQ: 'PK',
  JUEGO: 'SET', JUEGOS: 'SET', KIT: 'KT', PAR: 'PR', PARES: 'PR', DOCENA: 'DZN', DOCENAS: 'DZN', DOC: 'DZN',
  CIENTO: 'CEN', CIENTOS: 'CEN', MILLAR: 'MLL', MILLARES: 'MLL',
  BOLSA: 'BG', BOLSAS: 'BG', BOTELLA: 'BO', BOTELLAS: 'BO', ROLLO: 'RO', ROLLOS: 'RO', BOBINA: '4A', BOBINAS: '4A',
  BALDE: 'BJ', BALDES: 'BJ', FARDO: 'BE', LATA: 'CA', LATAS: 'CA', CILINDRO: 'CY', TAMBOR: 'DR', FRASCO: 'JR',
  PLANCHA: 'ST', PLANCHAS: 'ST', PLIEGO: 'ST', HOJA: 'LEF', HOJAS: 'LEF', RESMA: 'RM', TUBO: 'TU', TUBOS: 'TU',
  // Ferretería, gasfitería y construcción.
  SACO: 'SA', SACOS: 'SA', SCO: 'SA',
  VARILLA: 'RD', VARILLAS: 'RD', VAR: 'RD', VRL: 'RD', FIERRO: 'RD',
  BARRA: 'BR', BARRAS: 'BR',
  TIRA: 'SR', TIRAS: 'SR', LISTON: 'SR', LISTONES: 'SR',
  TABLA: 'BD', TABLAS: 'BD', TABLON: 'BD', TABLONES: 'BD',
  BIDON: 'CO', BIDONES: 'CO', GARRAFA: 'CO', GARRAFON: 'CO',
  CUARTO: 'QT', '1/4': 'QT', '1/4 GL': 'QT', '1/4 GLN': 'QT', '1/4 GALON': 'QT', 'CUARTO DE GALON': 'QT',
  PINTA: 'PT', '1/8': 'PT', '1/8 GL': 'PT', '1/8 GALON': 'PT',
  HORA: 'HUR', HORAS: 'HUR', HR: 'HUR', HRS: 'HUR',
  DIA: 'DAY', DIAS: 'DAY',
  // Variantes de unidades que ya estaban en el catálogo. Nunca 'ML' → metro lineal: ML es mililitro.
  MTL: 'MTR', 'METRO LINEAL': 'MTR', 'ML LINEAL': 'MTR',
  GLS: 'GLL', JGO: 'SET', JGOS: 'SET', PQTE: 'PK', ROL: 'RO', RLL: 'RO', BLD: 'BJ', CIL: 'CY', PLG: 'INH',
  'C/U': 'NIU', CU: 'NIU', PZ: 'C62',
  CALAMINA: 'ST', CALAMINAS: 'ST', PLACA: 'PG', PLACAS: 'PG', CUBETA: 'PL', CUBETAS: 'PL',
  CONO: 'CJ', CONOS: 'CJ', PALETA: 'PF', PALETAS: 'PF', PALLET: 'PF',
  KITS: 'KT', GRUESA: 'GRO', BARRIL: 'BLL', BARRILES: 'BLL', HL: 'HLT',
};

export function esUnidadCatalogo03(codigo: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNIDADES_CATALOGO_03, codigo);
}

/**
 * Normaliza la unidad de un producto al catálogo 03. Acepta el código oficial
 * o un sinónimo (UND, KG, M2…). Si no la reconoce devuelve NIU con una
 * advertencia, para no enviar a SUNAT un código inválido (que rechazaría el
 * comprobante y quemaría su número).
 */
export function normalizarUnidad(unidad: string | null | undefined): { codigo: string; advertencia?: string } {
  const limpia = String(unidad ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!limpia) {
    return { codigo: 'NIU', advertencia: 'El producto no tiene unidad de medida: se usará NIU (unidad).' };
  }
  if (esUnidadCatalogo03(limpia)) return { codigo: limpia };
  const alias = ALIAS_UNIDADES[limpia];
  if (alias) return { codigo: alias };
  return {
    codigo: 'NIU',
    advertencia: `La unidad "${String(unidad).trim()}" no existe en el catálogo 03 de SUNAT: se usará NIU (unidad). Corrija el producto.`,
  };
}

/**
 * Consumidor final ("clientes varios") para SUNAT directo. Las guías de SUNAT
 * piden tipo '0' con un guion cuando el adquirente no tiene documento; la
 * variante 'dni_ceros' ('1' / 00000000) es la que aceptaba NUBEFACT y queda
 * como respaldo si BETA no admite la primera.
 */
export type VarianteConsumidorFinal = 'sin_documento' | 'dni_ceros';

export const CONSUMIDOR_FINAL_SUNAT = Object.freeze({ tipoDoc: '0', numDoc: '-', nombre: 'CLIENTES VARIOS' });
const CONSUMIDOR_FINAL_DNI_CEROS = Object.freeze({ tipoDoc: '1', numDoc: '00000000', nombre: 'CLIENTES VARIOS' });

export function consumidorFinalSunat(variante: VarianteConsumidorFinal = 'sin_documento'): { tipoDoc: string; numDoc: string; nombre: string } {
  const base = variante === 'dni_ceros' ? CONSUMIDOR_FINAL_DNI_CEROS : CONSUMIDOR_FINAL_SUNAT;
  return { ...base };
}

/** true si el adquirente es el consumidor final genérico (sin documento real). */
export function esConsumidorFinal(tipoDoc: string | number | null | undefined, numDoc: string | null | undefined): boolean {
  const tipo = String(tipoDoc ?? '').trim();
  const numero = String(numDoc ?? '').trim();
  if (tipo === '' || tipo === '0') return true;
  return numero === '' || numero === '-' || /^0+$/.test(numero);
}

/** Catalogo 20 (Motivo de traslado) usado por la Guia de Remision Remitente. Lista abreviada con los motivos mas comunes. */
export const CATALOGO_20_MOTIVO_TRASLADO = {
  VENTA: '01',
  TRASLADO_ENTRE_ESTABLECIMIENTOS_DE_LA_MISMA_EMPRESA: '04',
  COMPRA: '08',
  OTROS: '13',
} as const;

/** Catalogo 21 (Modalidad de traslado) de la Guia de Remision Remitente. */
export const CATALOGO_21_MODALIDAD_TRASLADO = {
  TRANSPORTE_PUBLICO: '01',
  TRANSPORTE_PRIVADO: '02',
} as const;
