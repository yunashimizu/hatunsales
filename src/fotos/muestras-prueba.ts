import sharp from 'sharp';

/**
 * Imágenes de prueba generadas en memoria con `sharp` (sin archivos ni red), para los specs de la
 * mejora de fotos. La base imita una foto de catálogo: una herramienta con bordes nítidos, letras y
 * un poco de grano de sensor, sobre fondo casi blanco (#f5f5f5, como un estudio casero). Las degradaciones son las del experimento del plan
 * (§4.1): las mismas operaciones, sobre esta figura en vez de fotos reales.
 *
 * Solo la usan las pruebas; no la importa ningún código de la aplicación.
 */

export const ANCHO_BASE = 1200;
export const ALTO_BASE = 900;

/** Caja real de la figura dentro de la base (en px), para comprobar recortes. */
export const CAJA_FIGURA = { x0: 100, y0: 90, x1: 1100, y1: 810 };

/** Borde vacío añadido por lado en la muestra `borde`, en fracción del lado. */
export const BORDE_POR_LADO = 0.3;

/** Caja de la figura dentro de la muestra `borde` (1600 × 1200), en fracciones. */
export function cajaFiguraEnBorde() {
  const anchoTotal = ANCHO_BASE * (1 + 2 * BORDE_POR_LADO), altoTotal = ALTO_BASE * (1 + 2 * BORDE_POR_LADO);
  const mx = ANCHO_BASE * BORDE_POR_LADO, my = ALTO_BASE * BORDE_POR_LADO;
  return {
    x0: (mx + CAJA_FIGURA.x0) / anchoTotal, x1: (mx + CAJA_FIGURA.x1) / anchoTotal,
    y0: (my + CAJA_FIGURA.y0) / altoTotal, y1: (my + CAJA_FIGURA.y1) / altoTotal,
  };
}

/** Color plano de la pieza naranja (para comprobar que el tono no se mueve). */
export const COLOR_PIEZA = { r: 214, g: 110, b: 38 };
export const ZONA_PIEZA = { left: 160, top: 150, width: 300, height: 240 };

function svgFigura(ancho: number, alto: number): Buffer {
  const { x0, y0, x1, y1 } = CAJA_FIGURA;
  const c = COLOR_PIEZA;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#3b3e44"/>
  <rect x="${ZONA_PIEZA.left}" y="${ZONA_PIEZA.top}" width="${ZONA_PIEZA.width}" height="${ZONA_PIEZA.height}" fill="rgb(${c.r},${c.g},${c.b})"/>
  <rect x="560" y="150" width="480" height="240" fill="#c9ccd1"/>
  <g stroke="#15171a" stroke-width="3">
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${590 + i * 36}" y1="175" x2="${590 + i * 36}" y2="365"/>`).join('')}
  </g>
  <circle cx="310" cy="600" r="130" fill="#e8e9eb"/>
  <circle cx="310" cy="600" r="50" fill="#1b1c1f"/>
  <text x="560" y="540" font-family="DejaVu Sans, sans-serif" font-size="64" font-weight="bold" fill="#f2f2f2">2.4 mm  M8</text>
  <text x="560" y="680" font-family="DejaVu Sans, sans-serif" font-size="40" fill="#f2c14e">ACERO 18V</text>
</svg>`);
}

/**
 * Ruido casi gaussiano por canal, determinista. El experimento usó Box-Muller; aquí se suman 4 uniformes
 * (Irwin-Hall, misma media y desviación) porque bajo Jest cada `Math.log`/`Math.cos` cuesta 50–100 veces
 * más y generar las muestras tardaba 12 s. Para medir «grano» la diferencia no importa.
 */
export function ruidoGaussiano(buf: Buffer, sigma: number, semilla = 7): Buffer {
  let s = semilla >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const escala = sigma / 0.5773502692; // desviación de la suma de 4 uniformes = √(4/12)
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] + (rnd() + rnd() + rnd() + rnd() - 2) * escala;
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
  }
  return out;
}

async function crudo(entrada: Buffer) {
  return sharp(entrada).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function conRuido(entrada: Buffer, sigma: number, calidad = 92): Promise<Buffer> {
  const { data, info } = await crudo(entrada);
  return sharp(ruidoGaussiano(data, sigma), { raw: { width: info.width, height: info.height, channels: info.channels as 3 } })
    .jpeg({ quality: calidad })
    .toBuffer();
}

/** Base en crudo «de cámara»: figura nítida con un grano muy leve (σ 1,5), en PNG sin pérdida. */
export async function figuraBase(ancho = ANCHO_BASE, alto = ALTO_BASE): Promise<Buffer> {
  const png = await sharp(svgFigura(ancho, alto)).flatten({ background: '#ffffff' }).png().toBuffer();
  const { data, info } = await crudo(png);
  return sharp(ruidoGaussiano(data, 1.5, 3), { raw: { width: info.width, height: info.height, channels: info.channels as 3 } })
    .png()
    .toBuffer();
}

export interface MuestrasPrueba {
  buena: Buffer;
  desenfocada: Buffer;
  muyBorrosa: Buffer;
  oscura: Buffer;
  lavada: Buffer;
  ruidoFuerte: Buffer;
  borde: Buffer;
  chica240: Buffer;
  exif6: Buffer;
  exif6Borde: Buffer;
  transparente: Buffer;
  pngOpaco: Buffer;
}

/** Todas las muestras a la vez (≈ 1 s en la laptop). */
export async function generarMuestras(): Promise<MuestrasPrueba> {
  const base = await figuraBase();
  const jpeg = (img: ReturnType<typeof sharp>, calidad = 90) => img.jpeg({ quality: calidad, chromaSubsampling: '4:4:4' }).toBuffer();
  const buena = await jpeg(sharp(base), 92);

  // Borde blanco del 30 % por lado (el experimento usó 45 % sobre fotos de 1600 px; con esta figura de
  // 1200 px el 45 % dejaba el recorte en 786 px y además había que ampliar: aquí se quiere solo RECORTE).
  const mx = Math.round(ANCHO_BASE * BORDE_POR_LADO), my = Math.round(ALTO_BASE * BORDE_POR_LADO);
  const conBorde = await sharp(base)
    .extend({ top: my, bottom: my, left: mx, right: mx, background: '#ffffff' })
    .png()
    .toBuffer();
  const borde = await jpeg(sharp(conBorde).resize(1600, 1600, { fit: 'inside' }));

  // EXIF 6: el archivo guarda la foto girada 90° a la izquierda y pide girarla a la derecha al mostrarla.
  const exif6 = await sharp(base).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
  const exif6Borde = await sharp(await sharp(conBorde).resize(1600, 1600, { fit: 'inside' }).png().toBuffer())
    .rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();

  const transparente = await sharp(base).ensureAlpha()
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#000" fill-opacity="1"/></svg>'), blend: 'dest-out', left: 0, top: 0 }])
    .png().toBuffer();
  const pngOpaco = await sharp(base).ensureAlpha().png().toBuffer();

  return {
    buena,
    desenfocada: await jpeg(sharp(base).blur(1.2)),
    muyBorrosa: await jpeg(sharp(base).blur(2.5)),
    oscura: await jpeg(sharp(base).linear(0.42, 0)),
    lavada: await jpeg(sharp(base).linear(0.5, 75)),
    ruidoFuerte: await conRuido(base, 28),
    borde,
    chica240: await sharp(base).resize(240, 240, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer(),
    exif6,
    exif6Borde,
    transparente,
    pngOpaco,
  };
}

/** Escalón vertical de gris 60 → 200, suavizado como una foto real (σ 1,2), para medir halos. */
export async function escalon(ancho = 400, alto = 200): Promise<Buffer> {
  const data = Buffer.alloc(ancho * alto * 3);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const v = x < ancho / 2 ? 60 : 200;
      const j = (y * ancho + x) * 3;
      data[j] = data[j + 1] = data[j + 2] = v;
    }
  }
  return sharp(data, { raw: { width: ancho, height: alto, channels: 3 } }).blur(1.2).png().toBuffer();
}

/** JPEG de más de 25 Mpx de un solo color (se codifica por franjas: no ocupa 77 MB en memoria). */
export async function enorme(): Promise<Buffer> {
  return sharp({ create: { width: 6000, height: 4300, channels: 3, background: '#d0d0d0' } }).jpeg({ quality: 50 }).toBuffer();
}

/** WebP animado de dos cuadros. */
export async function animada(): Promise<Buffer> {
  const cuadro = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();
  return sharp([await cuadro('#ff0000'), await cuadro('#00ff00')], { join: { animated: true } }).webp().toBuffer();
}
