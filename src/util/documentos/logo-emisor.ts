import { Logger } from '@nestjs/common';
import axios from 'axios';
import { promises as fs } from 'fs';
import { join, normalize, sep } from 'path';
import { deflateSync, inflateSync } from 'zlib';

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
/**
 * Ancho máximo (px) del logo dentro del documento. En la hoja se dibuja a
 * ~120 pt, así que 420 px alcanzan para imprimir y hacer zoom sin pixelar,
 * y evitan que cada PDF/Excel cargue el original (que puede pesar varios MB).
 */
const ANCHO_MAXIMO_LOGO = 420;

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
      logo = await reducirLogo(datos);
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

/**
 * Reduce un PNG grande a `ANCHO_MAXIMO_LOGO` px de ancho, conservando la
 * transparencia. Es solo una optimización: ante cualquier duda (JPEG, PNG de
 * 16 bits, decodificación fallida) devuelve la imagen original intacta.
 */
export async function reducirLogo(datos: Buffer): Promise<Buffer> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PNG = require('png-js');
    if (!esPng(datos)) return datos;
    const png = new PNG(datos);
    const ancho: number = png.width;
    const alto: number = png.height;
    if (!ancho || !alto || png.bits !== 8 || ancho <= ANCHO_MAXIMO_LOGO) return datos;

    const nuevoAncho = ANCHO_MAXIMO_LOGO;
    const nuevoAlto = Math.max(1, Math.round((alto * nuevoAncho) / ancho));

    const rgba: Buffer = await new Promise((resolve, reject) => {
      try {
        png.decode((pixeles: Buffer) => resolve(pixeles));
      } catch (error) {
        reject(error);
      }
    });
    const reducido = codificarPng(
      reducirRgba(rgba, ancho, alto, nuevoAncho, nuevoAlto),
      nuevoAncho,
      nuevoAlto,
    );
    // Solo se usa si es más liviano y pasa la misma validación que el original.
    return reducido.length < datos.length && imagenSoportada(reducido) ? reducido : datos;
  } catch (error: any) {
    log.warn(`No se pudo reducir el logo (${error?.message ?? error}); se usa el original.`);
    return datos;
  }
}

/** Promedio por bloques ponderado por la transparencia (sin bordes oscuros). */
function reducirRgba(
  origen: Buffer,
  ancho: number,
  alto: number,
  nuevoAncho: number,
  nuevoAlto: number,
): Buffer {
  const salida = Buffer.alloc(nuevoAncho * nuevoAlto * 4);
  for (let y = 0; y < nuevoAlto; y++) {
    const y0 = Math.floor((y * alto) / nuevoAlto);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * alto) / nuevoAlto));
    for (let x = 0; x < nuevoAncho; x++) {
      const x0 = Math.floor((x * ancho) / nuevoAncho);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * ancho) / nuevoAncho));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * ancho + xx) * 4;
          const opacidad = origen[i + 3];
          r += origen[i] * opacidad;
          g += origen[i + 1] * opacidad;
          b += origen[i + 2] * opacidad;
          a += opacidad;
          n++;
        }
      }
      const o = (y * nuevoAncho + x) * 4;
      if (a > 0) {
        salida[o] = Math.round(r / a);
        salida[o + 1] = Math.round(g / a);
        salida[o + 2] = Math.round(b / a);
      }
      salida[o + 3] = Math.round(a / n);
    }
  }
  return salida;
}

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozoPng(tipo: string, datos: Buffer): Buffer {
  const cabecera = Buffer.alloc(8);
  cabecera.writeUInt32BE(datos.length, 0);
  cabecera.write(tipo, 4, 'ascii');
  const cuerpo = Buffer.concat([cabecera.subarray(4), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([cabecera, datos, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG RGBA de 8 bits con filtro Paeth (comprime mucho mejor que sin filtro). Exportada para pruebas. */
export function codificarPng(rgba: Buffer, ancho: number, alto: number): Buffer {
  const fila = ancho * 4;
  const crudo = Buffer.alloc((fila + 1) * alto);
  for (let y = 0; y < alto; y++) {
    const destino = y * (fila + 1);
    crudo[destino] = 4;
    for (let i = 0; i < fila; i++) {
      const x = rgba[y * fila + i];
      const a = i >= 4 ? rgba[y * fila + i - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * fila + i] : 0;
      const c = y > 0 && i >= 4 ? rgba[(y - 1) * fila + i - 4] : 0;
      crudo[destino + 1 + i] = (x - paeth(a, b, c)) & 0xff;
    }
  }
  const cabeceraImagen = Buffer.alloc(13);
  cabeceraImagen.writeUInt32BE(ancho, 0);
  cabeceraImagen.writeUInt32BE(alto, 4);
  cabeceraImagen[8] = 8; // bits por canal
  cabeceraImagen[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozoPng('IHDR', cabeceraImagen),
    trozoPng('IDAT', deflateSync(crudo, { level: 9 })),
    trozoPng('IEND', Buffer.alloc(0)),
  ]);
}
