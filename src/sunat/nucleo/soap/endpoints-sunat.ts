import type { AmbienteFiscal } from '../documento-fiscal.types';

/**
 * Servicios SOAP de SUNAT (WSDL leídos en vivo el 07/10/2026, design §2).
 *  - billService: sendBill, sendSummary, getStatus (ticket) y sendPack.
 *  - billConsultService: getStatusCdr y getStatus (consulta por RUC, tipo,
 *    serie y número). Solo existe en producción.
 *  - billValidService: validaCDPcriterios (consulta de validez con datos del
 *    adquirente); declarado para una fase posterior.
 *  - guiaRemision: GRE por SOAP (obsoleta: la GRE vigente va por API REST).
 * BETA no tiene servicios de consulta.
 */
export interface EndpointsSunat {
  billService: string;
  consultaCdr: string | null;
  consultaValidez: string | null;
  guiaRemision: string;
}

export const ENDPOINTS_SUNAT: Readonly<Record<AmbienteFiscal, Readonly<EndpointsSunat>>> = Object.freeze({
  beta: Object.freeze({
    billService: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
    consultaCdr: null,
    consultaValidez: null,
    guiaRemision: 'https://e-beta.sunat.gob.pe/ol-ti-itemision-guia-gem-beta/billService',
  }),
  produccion: Object.freeze({
    billService: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
    consultaCdr: 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService',
    consultaValidez: 'https://e-factura.sunat.gob.pe/ol-it-wsconsvalidcpe/billValidService',
    guiaRemision: 'https://e-guiaremision.sunat.gob.pe/ol-ti-itemision-guia-gem/billService',
  }),
});

/** Hosts de PRODUCCIÓN: un cliente configurado en BETA nunca debe apuntar a ellos. */
export const HOSTS_PRODUCCION_SUNAT: ReadonlySet<string> = new Set([
  'e-factura.sunat.gob.pe',
  'e-guiaremision.sunat.gob.pe',
  'api-cpe.sunat.gob.pe',
  'api-seguridad.sunat.gob.pe',
]);

export function endpointsSunat(ambiente: AmbienteFiscal): Readonly<EndpointsSunat> {
  return ENDPOINTS_SUNAT[ambiente === 'produccion' ? 'produccion' : 'beta'];
}

/** true si la URL apunta a un servicio de producción de SUNAT. */
export function esEndpointProduccion(url: string): boolean {
  try {
    return HOSTS_PRODUCCION_SUNAT.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
