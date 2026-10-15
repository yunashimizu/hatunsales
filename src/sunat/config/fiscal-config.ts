import { ENDPOINTS_SUNAT, endpointsSunat, EndpointsSunat } from '../nucleo/soap/endpoints-sunat';

export type AmbienteFiscal = 'beta' | 'produccion';

export interface FiscalConfig {
  ambiente: AmbienteFiscal;
  proveedorActivo: 'none' | 'sunat-direct';
  proveedorHabilitado: boolean;
  serieFactura?: string;
  serieBoleta?: string;
  serieNotaCredito?: string;
  serieGuia?: string;
  certificadoActivo?: boolean;
  certificadoVencido?: boolean;
  ultimoError?: string;
}

/**
 * Endpoints SOAP verificados contra los WSDL oficiales (design §2):
 *  - facturaBoletaNotaCredito: billService (sendBill, sendSummary, getStatus).
 *  - consultaCdr: billConsultService (getStatusCdr y getStatus por RUC, tipo,
 *    serie y número). Solo producción: BETA no tiene servicio de consulta.
 *  - consultaValidez: billValidService (validaCDPcriterios), para una fase posterior.
 *  - guiaRemision: GRE por SOAP (obsoleta; la vigente va por API REST).
 * La fuente única es ENDPOINTS_SUNAT del núcleo.
 */
export const SUNAT_ENDPOINTS = {
  beta: {
    facturaBoletaNotaCredito: ENDPOINTS_SUNAT.beta.billService,
    guiaRemision: ENDPOINTS_SUNAT.beta.guiaRemision,
    consultaCdr: null,
    consultaValidez: null,
  },
  produccion: {
    facturaBoletaNotaCredito: ENDPOINTS_SUNAT.produccion.billService,
    guiaRemision: ENDPOINTS_SUNAT.produccion.guiaRemision,
    consultaCdr: ENDPOINTS_SUNAT.produccion.consultaCdr,
    consultaValidez: ENDPOINTS_SUNAT.produccion.consultaValidez,
  },
} as const;

/** Endpoints del núcleo para un ambiente (billService, consultaCdr, consultaValidez, guiaRemision). */
export function endpointsFiscales(ambiente: AmbienteFiscal): Readonly<EndpointsSunat> {
  return endpointsSunat(ambiente);
}

/**
 * @deprecated Configuración heredada por variables de entorno. La
 * configuración real vive en FiscalConfigService (tabla configuraciones,
 * editable desde Panel → Facturación SUNAT). Se mantiene para la ruta BETA
 * antigua (/sunat/beta/*) y sus specs.
 */
export function getFiscalConfig(): FiscalConfig {
  const proveedorActivo = (process.env.SUNAT_FISCAL_PROVIDER ?? 'none').toLowerCase();
  const ambiente = (process.env.SUNAT_FISCAL_ENVIRONMENT ?? 'beta').toLowerCase() === 'produccion'
    ? 'produccion'
    : 'beta';
  const proveedorHabilitado = (process.env.SUNAT_DIRECT_ENABLED ?? 'false').toLowerCase() === 'true'
    && proveedorActivo === 'sunat-direct';

  return {
    ambiente,
    proveedorActivo: proveedorActivo === 'sunat-direct' ? 'sunat-direct' : 'none',
    proveedorHabilitado,
    // Defaults validos contra el propio validador de cada documento
    // (Factura F###, Boleta B###, Guia T###); la Nota de Credito no tiene
    // un default fijo porque su prefijo depende del documento que modifica.
    serieFactura: process.env.SUNAT_SERIE_FACTURA ?? 'F001',
    serieBoleta: process.env.SUNAT_SERIE_BOLETA ?? 'B001',
    serieNotaCredito: process.env.SUNAT_SERIE_NOTA,
    serieGuia: process.env.SUNAT_SERIE_GUIA ?? 'T001',
    certificadoActivo: Boolean(process.env.SUNAT_CERT_PATH && process.env.SUNAT_CERT_PASSWORD),
    certificadoVencido: false,
    ultimoError: proveedorHabilitado ? 'Proveedor fiscal habilitado, pendiente de activación segura' : 'Proveedor fiscal inactivo en Fase 1',
  };
}

/**
 * @deprecated Endpoint billService según tipo y ambiente, para la ruta BETA
 * antigua. El código nuevo usa SunatSoapClient (elige el endpoint por ambiente).
 * SUNAT_BILL_ENDPOINT lo reemplaza (solo pruebas).
 */
export function endpointBillServicePorTipo(documentType: '01' | '03' | '07' | '08' | '09', ambiente: AmbienteFiscal): string {
  const overrideEnv = process.env.SUNAT_BILL_ENDPOINT;
  if (overrideEnv) return overrideEnv;

  const set = SUNAT_ENDPOINTS[ambiente];
  return documentType === '09' ? set.guiaRemision : set.facturaBoletaNotaCredito;
}

/** @deprecated Se evalúa al cargar el módulo; use FiscalConfigService. */
export const fiscalConfigDefault: FiscalConfig = getFiscalConfig();
