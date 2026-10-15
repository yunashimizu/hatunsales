import { EstadoCdr, leerCdr } from '../nucleo/cdr/lector-cdr';
import type { ObservacionSunat } from '../nucleo/documento-fiscal.types';

export interface CdrParseResult {
  codigo: string;
  descripcion: string;
  /** Observaciones como texto ("4252 - El dato ingresado…"), forma heredada. */
  observaciones: string[];
  /**
   * 0 sin notas → ACEPTADO; 0 con notas o ≥ 4000 → ACEPTADO_CON_OBSERVACIONES;
   * 2000–3999 → RECHAZADO; 0100–1999 → EXCEPCION (Manual del Programador §4.1).
   */
  estado: EstadoCdr | 'ERROR_TRANSPORTE';
  rawXml: string;
  /** Observaciones separadas en código y descripción. */
  observacionesDetalle?: ObservacionSunat[];
  /** cbc:ReferenceID del comprobante al que responde. */
  referencia?: string;
}

/**
 * Interpreta la constancia (ApplicationResponse) de SUNAT con @xmldom, sin
 * depender de prefijos ni atributos (<cbc:ResponseCode listAgencyName="PE:SUNAT">).
 */
export class CdrParserService {
  parse(xml: string): CdrParseResult {
    const cdr = leerCdr(xml);
    return {
      codigo: cdr.codigo,
      descripcion: cdr.descripcion,
      observaciones: cdr.observaciones.map((o) => (o.codigo ? `${o.codigo} - ${o.descripcion}` : o.descripcion)),
      estado: cdr.estado,
      rawXml: xml,
      observacionesDetalle: cdr.observaciones,
      referencia: cdr.referencia,
    };
  }
}
