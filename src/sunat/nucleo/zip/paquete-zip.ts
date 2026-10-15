import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import type { PaqueteZip } from '../documento-fiscal.types';
import { PaqueteZipError } from '../errores-nucleo';
import { PATRON_NOMBRE_BASE_CPE, PATRON_NOMBRE_RESUMEN } from '../identificadores-cpe';
import { PATRON_RAIZ_DOCUMENTO_SUNAT } from '../ubl/espacios-ubl';

/** Límites al descomprimir respuestas de SUNAT (protección ante ZIP bomba). */
export const MAXIMO_BYTES_XML_EN_ZIP = 5 * 1024 * 1024;
export const MAXIMO_ENTRADAS_ZIP = 10;

export function sha256Hex(contenido: Buffer | string): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/** true para RUC-TT-SERIE-NUMERO (01, 03, 07, 08, 09) y RUC-RC|RA-YYYYMMDD-N. */
export function esNombreBaseSunat(nombreBase: string): boolean {
  return PATRON_NOMBRE_BASE_CPE.test(nombreBase) || PATRON_NOMBRE_RESUMEN.test(nombreBase);
}

/**
 * ZIP que espera SUNAT: una sola entrada `${nombreBase}.xml` con el XML
 * firmado (UTF-8). Sirve para comprobantes, resúmenes, bajas y la GRE.
 * Devuelve también el SHA-256 del ZIP en hexadecimal (hashZip de la GRE).
 */
export function empaquetarZip(nombreBase: string, xml: string): PaqueteZip {
  if (typeof nombreBase !== 'string' || !esNombreBaseSunat(nombreBase)) {
    throw new PaqueteZipError(`El nombre "${String(nombreBase)}" no sigue la convención de SUNAT (RUC-TT-SERIE-NUMERO o RUC-RC/RA-YYYYMMDD-N).`);
  }
  if (typeof xml !== 'string' || !PATRON_RAIZ_DOCUMENTO_SUNAT.test(xml)) {
    throw new PaqueteZipError('El contenido no es un documento XML de SUNAT: no se empaqueta.');
  }
  const nombreXml = `${nombreBase}.xml`;
  const archivo = new AdmZip();
  archivo.addFile(nombreXml, Buffer.from(xml, 'utf8'));
  const zip = archivo.toBuffer();
  return {
    nombreZip: `${nombreBase}.zip`,
    nombreXml,
    zip,
    base64: zip.toString('base64'),
    sha256: sha256Hex(zip),
  };
}

/**
 * Lee la primera entrada .xml de un ZIP (la constancia de SUNAT viene como
 * R-RUC-TT-SERIE-NUMERO.xml). Devuelve null si el ZIP es ilegible o no trae XML.
 */
export function leerXmlDeZip(contenido: Buffer | string): { nombre: string; xml: string } | null {
  try {
    const buffer = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido).replace(/\s+/g, ''), 'base64');
    if (buffer.length === 0) return null;
    const entradas = new AdmZip(buffer).getEntries();
    if (entradas.length === 0 || entradas.length > MAXIMO_ENTRADAS_ZIP) return null;
    const entrada = entradas.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml'));
    if (!entrada || entrada.header.size > MAXIMO_BYTES_XML_EN_ZIP) return null;
    const datos = entrada.getData();
    if (datos.length > MAXIMO_BYTES_XML_EN_ZIP) return null;
    return { nombre: entrada.entryName, xml: datos.toString('utf8') };
  } catch {
    return null;
  }
}
