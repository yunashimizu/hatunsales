import { Logger } from '@nestjs/common';
import axios from 'axios';
import { promises as fs } from 'fs';
import { join, normalize, sep } from 'path';
import { inflateSync } from 'zlib';

/**
 * Descarga (con caché en memoria) el logo del emisor para imprimirlo en la
 * proforma. Cualquier problema —URL caída, lenta, formato no soportado o
 * imagen corrupta— devuelve null y el documento sale sin logo: nunca debe
 * impedir que se genere el PDF.
 */

const TIMEOUT_MS = 3_000;
const TAMANO_MAXIMO = 2 * 1024 * 1024;
const VIGENCIA_OK_MS = 30 * 60_000;
const VIGENCIA_FALLO_MS = 5 * 60_000;

const log = new Logger('LogoEmisor');
const cache = new Map<string, { logo: Buffer | null; expira: number }>();

export async function obtenerLogoEmisor(url: string | null | undefined): Promise<Buffer | null> {
  const origen = String(url ?? '').trim();
  if (!origen) return null;

  const enCache = cache.get(origen);
  if (enCache && enCache.expira > Date.now()) return enCache.logo;

  let logo: Buffer | null = null;
  try {
    const datos = await leerOrigen(origen);
    if (datos && datos.length <= TAMANO_MAXIMO && imagenSoportada(datos)) {
      logo = datos;
    } else if (datos) {
      log.warn(`El logo del emisor no es PNG/JPEG válido o pesa más de 2 MB; la proforma saldrá sin logo.`);
    }
  } catch (error: any) {
    log.warn(`No se pudo obtener el logo del emisor (${error?.message ?? error}); la proforma saldrá sin logo.`);
  }

  cache.set(origen, {
    logo,
    expira: Date.now() + (logo ? VIGENCIA_OK_MS : VIGENCIA_FALLO_MS),
  });
  return logo;
}

/** Solo para pruebas. */
export function limpiarCacheLogo(): void {
  cache.clear();
}

async function leerOrigen(origen: string): Promise<Buffer | null> {
  const dataUri = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(origen);
  if (dataUri) return Buffer.from(dataUri[2], 'base64');

  if (/^https?:\/\//i.test(origen)) {
    const respuesta = await axios.get<ArrayBuffer>(origen, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      // Límite duro: timeout de axios solo vigila la inactividad del socket.
      signal: AbortSignal.timeout(TIMEOUT_MS),
      maxContentLength: TAMANO_MAXIMO,
      maxRedirects: 3,
      validateStatus: (estado) => estado === 200,
    });
    return Buffer.from(respuesta.data);
  }

  // Archivo servido por la propia API en /uploads/...
  const relativo = origen.replace(/^\/+/, '');
  if (relativo.startsWith('uploads/')) {
    const base = join(process.cwd(), 'uploads');
    const ruta = normalize(join(process.cwd(), relativo));
    if (!ruta.startsWith(base + sep)) return null;
    return fs.readFile(ruta);
  }

  return null;
}

function esJpeg(datos: Buffer): boolean {
  return datos.length > 4 && datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff;
}

function esPng(datos: Buffer): boolean {
  return (
    datos.length > 8 &&
    datos.readUInt32BE(0) === 0x89504e47 &&
    datos.readUInt32BE(4) === 0x0d0a1a0a
  );
}

/**
 * pdfkit decodifica los PNG con transparencia de forma asíncrona y, si los
 * datos están dañados, lanza el error dentro de un callback (tumbaría el
 * proceso). Por eso el PNG se valida aquí completo y de forma síncrona.
 */
export function imagenSoportada(datos: Buffer): boolean {
  if (esJpeg(datos)) return true;
  if (!esPng(datos)) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PNG = require('png-js');
    const png = new PNG(datos);
    if (!png.width || !png.height || !png.imgData?.length) return false;
    const pixeles: Buffer = inflateSync(png.imgData);
    if (png.interlaceMethod) return pixeles.length > 0;

    const bytesPorFila = Math.ceil((png.width * png.pixelBitlength) / 8);
    if (pixeles.length < png.height * (bytesPorFila + 1)) return false;
    for (let fila = 0; fila < png.height; fila++) {
      if (pixeles[fila * (bytesPorFila + 1)] > 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}
