import type { PaqueteZip } from '../nucleo/documento-fiscal.types';
import { PaqueteZipError } from '../nucleo/errores-nucleo';
import { nombreBaseCpe } from '../nucleo/identificadores-cpe';
import { empaquetarZip } from '../nucleo/zip/paquete-zip';

// API del núcleo (contrato §12.1): ZIP genérico para comprobantes, RC, RA y GRE.
export { empaquetarZip, leerXmlDeZip, sha256Hex } from '../nucleo/zip/paquete-zip';

export interface FacturaZipResultado {
  ok: boolean;
  fileName: string;
  zipBase64: string;
  mensaje: string;
}

const TIPOS_ZIP = new Set(['01', '03', '07', '08', '09']);

export class FacturaBetaZipService {
  /**
   * @deprecated Firma heredada (la usan los proveedores BETA y la GRE SOAP).
   * Empaqueta `${ruc}-${tipo}-${serie}-${numero(8)}.xml` dentro de `….zip`.
   */
  generarZip(xmlFirmado: string, ruc: string, tipo: string, serie: string, numero: number): FacturaZipResultado {
    if (!TIPOS_ZIP.has(tipo)) {
      throw new PaqueteZipError(`Tipo de documento no válido para el ZIP: "${tipo}".`);
    }
    const paquete = empaquetarZip(nombreBaseCpe(ruc, tipo as '01' | '03' | '07' | '08' | '09', serie, numero), xmlFirmado);
    return {
      ok: true,
      fileName: paquete.nombreZip,
      zipBase64: paquete.base64,
      mensaje: 'ZIP SUNAT preparado correctamente.',
    };
  }

  /** ZIP genérico: `${nombreBase}.xml` dentro; devuelve el buffer, base64 y SHA-256 (hex). */
  empaquetarZip(nombreBase: string, xml: string): PaqueteZip {
    return empaquetarZip(nombreBase, xml);
  }
}
