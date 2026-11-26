import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

/**
 * Anchos que se pueden pedir con `?w=`. Es una lista cerrada a propósito: si cualquier número
 * fuera válido, cada valor distinto sería una copia nueva en la caché y un trabajo nuevo para
 * el procesador. Un valor intermedio se sube al ancho permitido más cercano.
 */
export const ANCHOS_IMAGEN = [160, 320, 480, 640, 800, 1200, 1600] as const;

/** Tipos que se pueden reducir. El GIF se deja tal cual: reducirlo le quitaría la animación. */
const TIPOS_REDIMENSIONABLES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/** Tope de memoria para las variantes ya calculadas (el contenedor es chico). */
const MAXIMO_BYTES_EN_CACHE = 32 * 1024 * 1024;

/** Evita decodificar imágenes desmesuradas (una foto de 50 Mpx ya es mucho más de lo normal). */
const MAXIMO_PIXELES_ENTRADA = 80_000_000;

let sharpConfigurado = false;

/**
 * Contenedor pequeño: poca memoria interna de libvips y pocos hilos. La usan el redimensionador
 * de `?w=` y el mejorador de fotos (src/fotos); es idempotente, así nadie la pisa con otros valores.
 */
export function configurarSharp(): void {
  if (sharpConfigurado) return;
  sharp.cache({ memory: 48, files: 0, items: 40 });
  sharp.concurrency(2);
  sharpConfigurado = true;
}

export interface VarianteImagen {
  contenido: Buffer;
  mime: string;
}

/**
 * Traduce el `?w=` recibido al ancho permitido. `null` significa «sirve la original»:
 * valor ausente, no numérico, no positivo o mayor que el último ancho de la lista.
 */
export function anchoSolicitado(valor: unknown): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return ANCHOS_IMAGEN.find((ancho) => ancho >= numero) ?? null;
}

export function sePuedeRedimensionar(mime: string): boolean {
  return TIPOS_REDIMENSIONABLES.includes((mime ?? '').toLowerCase());
}

/**
 * Medidas reales de una imagen, ya con la orientación EXIF aplicada (una foto de celular
 * girada de lado se guarda 4000×3000 pero se ve 3000×4000). Si no se puede leer devuelve `{}`:
 * las medidas son un dato útil, no una condición para guardar la foto.
 */
export async function medirImagen(buffer: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const girada = (meta.orientation ?? 1) >= 5;
    const width = girada ? meta.height : meta.width;
    const height = girada ? meta.width : meta.height;
    return { width: width || undefined, height: height || undefined };
  } catch {
    return {};
  }
}

/**
 * Genera versiones más chicas de una imagen guardada y las recuerda un rato.
 *
 * Existe porque el almacén «base de datos» solo guarda el archivo original: sin esto cada
 * tarjeta del catálogo, del POS o del carrito descargaba la foto entera. Con Cloudinary no hace
 * falta (las medidas se piden por URL), pero el sistema funciona con cualquiera de los dos.
 */
@Injectable()
export class RedimensionadorImagen {

  private readonly logger = new Logger(RedimensionadorImagen.name);
  /** Map conserva el orden de inserción: la primera clave es la menos usada recientemente. */
  private readonly cache = new Map<string, VarianteImagen>();
  private bytesEnCache = 0;
  /** Dos pedidos iguales a la vez comparten un solo trabajo. */
  private readonly enCurso = new Map<string, Promise<VarianteImagen | null>>();

  constructor() {
    configurarSharp();
  }

  /**
   * @param huella identifica el contenido (su hash): dos ids con la misma foto comparten caché.
   * @returns la variante, o `null` si no se pudo o no corresponde (quien llama sirve la original).
   */
  async variante(
    huella: string,
    original: Buffer,
    mime: string,
    ancho: number,
    aceptaWebp: boolean,
  ): Promise<VarianteImagen | null> {
    if (!sePuedeRedimensionar(mime)) return null;

    const clave = `${huella}|${ancho}|${aceptaWebp ? 'webp' : 'orig'}`;

    const guardada = this.cache.get(clave);
    if (guardada) {
      // Se vuelve a insertar para que quede como la más reciente.
      this.cache.delete(clave);
      this.cache.set(clave, guardada);
      return guardada;
    }

    const pendiente = this.enCurso.get(clave);
    if (pendiente) return pendiente;

    const trabajo = this.generar(original, mime, ancho, aceptaWebp)
      .then((resultado) => {
        if (resultado) this.recordar(clave, resultado);
        return resultado;
      })
      .finally(() => this.enCurso.delete(clave));

    this.enCurso.set(clave, trabajo);
    return trabajo;
  }

  private async generar(
    original: Buffer,
    mime: string,
    ancho: number,
    aceptaWebp: boolean,
  ): Promise<VarianteImagen | null> {
    try {
      const base = sharp(original, { failOn: 'none', limitInputPixels: MAXIMO_PIXELES_ENTRADA })
        .rotate() // aplica la orientación EXIF y la quita del resultado
        .resize({ width: ancho, withoutEnlargement: true, fit: 'inside' });

      if (aceptaWebp) {
        return { contenido: await base.webp({ quality: 80 }).toBuffer(), mime: 'image/webp' };
      }
      // Sin WebP se conserva el PNG (puede tener transparencia); lo demás sale como JPEG.
      if (mime.toLowerCase() === 'image/png') {
        return { contenido: await base.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
      }
      return { contenido: await base.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
    } catch (error: any) {
      this.logger.warn(`No se pudo reducir la imagen a ${ancho}px: ${error?.message ?? error}`);
      return null;
    }
  }

  private recordar(clave: string, variante: VarianteImagen): void {
    const peso = variante.contenido.length;
    if (peso > MAXIMO_BYTES_EN_CACHE / 2) return; // una sola pieza no debe vaciar la caché

    while (this.bytesEnCache + peso > MAXIMO_BYTES_EN_CACHE && this.cache.size) {
      const masAntigua = this.cache.keys().next().value as string;
      this.bytesEnCache -= this.cache.get(masAntigua)!.contenido.length;
      this.cache.delete(masAntigua);
    }

    this.cache.set(clave, variante);
    this.bytesEnCache += peso;
  }
}
