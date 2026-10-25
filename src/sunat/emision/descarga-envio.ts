import { StreamableFile } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { EmisionDirecta, TIPOS_ARCHIVO_ENVIO, TipoArchivoEnvio } from './emision.contrato';

/** Solo se sirven los tipos que guarda la emisión; cualquier otro valor sale como binario genérico. */
const MIMES_PERMITIDOS: ReadonlySet<string> = new Set(['application/xml', 'application/zip']);

/** [A-Za-z0-9._-]: el nombre nunca rompe ni inyecta nada en Content-Disposition (D13). */
export function nombreArchivoSeguro(nombre: string | null | undefined): string {
  const limpio = String(nombre ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 150);
  return limpio || 'archivo';
}

/**
 * Artefacto de un envío como descarga (las cabeceras fijas de D13 las pone el controlador con @Header).
 * 400 si el tipo no es de la lista cerrada; 404 si el envío no lo tiene.
 */
export async function descargaDeEnvio(emision: EmisionDirecta, idEnvio: number, tipo: string): Promise<StreamableFile> {
  if (!(TIPOS_ARCHIVO_ENVIO as readonly string[]).includes(tipo)) {
    throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `Tipo de archivo no válido. Use: ${TIPOS_ARCHIVO_ENVIO.join(', ')}.`);
  }
  const archivo = await emision.obtenerArchivo(idEnvio, tipo as TipoArchivoEnvio);
  if (!archivo) throw new FiscalConfigError('FISCAL_XML_NO_DISPONIBLE', 'El archivo no está disponible en ese envío.');
  return new StreamableFile(archivo.contenido, {
    type: MIMES_PERMITIDOS.has(archivo.mime) ? archivo.mime : 'application/octet-stream',
    disposition: `attachment; filename="${nombreArchivoSeguro(archivo.nombre)}"`,
    length: archivo.contenido.length,
  });
}
