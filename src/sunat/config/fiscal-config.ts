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
 * Endpoints SOAP verificados contra fuentes oficiales SUNAT (Manual del
 * Programador SEE-Sistemas del Contribuyente, cpe.sunat.gob.pe; orientacion.sunat.gob.pe/12-pautas-servicio-beta).
 * Factura/Boleta/Nota de Crédito comparten el mismo servicio billService.
 * La Guía de Remisión usa un subdominio y un Beta propios y distintos
 * (e-guiaremision, no e-factura); SUNAT tambien ofrece para GRE una via
 * REST/OAuth2 alterna ("Plataforma Nueva GRE") no implementada aquí todavía.
 */
export const SUNAT_ENDPOINTS = {
  beta: {
    facturaBoletaNotaCredito: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
    guiaRemision: 'https://e-beta.sunat.gob.pe/ol-ti-itemision-guia-gem-beta/billService',
  },
  produccion: {
    facturaBoletaNotaCredito: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
    guiaRemision: 'https://e-guiaremision.sunat.gob.pe/ol-ti-itemision-guia-gem/billService',
  },
} as const;

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

/** Endpoint SOAP correcto según el ambiente configurado y el tipo de documento. */
export function endpointBillServicePorTipo(documentType: '01' | '03' | '07' | '09', ambiente: AmbienteFiscal): string {
  const overrideEnv = process.env.SUNAT_BILL_ENDPOINT;
  if (overrideEnv) return overrideEnv;

  const set = SUNAT_ENDPOINTS[ambiente];
  return documentType === '09' ? set.guiaRemision : set.facturaBoletaNotaCredito;
}

export const fiscalConfigDefault: FiscalConfig = getFiscalConfig();
