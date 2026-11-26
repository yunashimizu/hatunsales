import sharp from 'sharp';
import { configurarSharp } from '../util/storage/redimensionador-imagen';
import { LADO_PUBLICACION, UMBRALES_MEJORA } from './umbrales-mejora';

/**
 * Mide una foto de producto (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §5.1 y anexo). Una sola
 * decodificación, ya girada por EXIF, aplanada sobre blanco y reducida a ≤ 1600 px; lo demás es
 * aritmética sobre ese búfer. No decide nada: eso lo hace `decidirReceta` (receta-mejora.ts).
 */

export interface MedidasImagen {
  /** Medidas del búfer medido (≤ 1600 px de lado). */
  w: number;
  h: number;
  p1: number;
  p50: number;
  p99: number;
  p995: number;
  rango: number;
  fondo: { r: number; g: number; b: number; L: number; uniformidad: number; tinte: number };
  /** Caja del sujeto en fracciones del ancho y del alto (0–1). */
  caja: { x0: number; x1: number; y0: number; y1: number };
  ocupacion: number;
  sujetoFrac: number;
  p1Sujeto: number;
  p99Sujeto: number;
  /** Σ|laplaciano| ÷ Σ gradiente sobre los bordes fuertes. Nítida ≥ 0,36. */
  agudeza: number;
  /** Residuo de Immerkær (percentil 10 de los bloques de 8×8); `null` si casi todo está quemado. */
  ruido: number | null;
  /** Cuadritos de JPEG; `null` si hubo que reducir la imagen para medir. */
  bloques: number | null;
  bloquesDif: number | null;
  /** Parte de los píxeles en blanco puro (≥ 252) y negro puro (≤ 3): de la imagen entera y solo del sujeto. */
  blancoTotal: number;
  negroTotal: number;
  blancoSujeto: number;
  negroSujeto: number;
  /** Color medio del sujeto (o `null` si no hay sujeto) y de la imagen entera. */
  colorSujeto: { r: number; g: number; b: number } | null;
  colorTotal: { r: number; g: number; b: number };
}

export interface AnalisisImagen {
  /** Medidas reales tras aplicar la orientación EXIF. */
  ancho: number;
  alto: number;
  formato: string;
  orientacion: number;
  /** Transparencia de verdad (algún píxel no opaco), no solo «tiene canal alfa». */
  alfa: boolean;
  paginas: number;
  pixeles: number;
  /** `null` cuando no se decodificó: animada, con transparencia o demasiado grande. */
  medidas: MedidasImagen | null;
  ms: number;
}

export interface OpcionesAnalisis {
  pixelesMaximos?: number;
  segundosPorLlamada?: number;
}

const BLANCO = { r: 255, g: 255, b: 255 };

export async function analizarImagen(buffer: Buffer, opciones: OpcionesAnalisis = {}): Promise<AnalisisImagen> {
  configurarSharp();
  const inicio = Date.now();
  const pixelesMaximos = opciones.pixelesMaximos ?? UMBRALES_MEJORA.pixelesMaximos;
  const segundos = opciones.segundosPorLlamada ?? UMBRALES_MEJORA.segundosPorLlamada;

  // La cabecera no decodifica píxeles: sirve para descartar lo animado o desmesurado sin gastar memoria.
  const meta = await sharp(buffer, { failOn: 'none', limitInputPixels: false }).metadata();
  const orientacion = meta.orientation ?? 1;
  const girada = orientacion >= 5;
  const anchoBruto = meta.width ?? 0;
  const altoBruto = meta.pageHeight && (meta.pages ?? 1) > 1 ? meta.pageHeight : (meta.height ?? 0);
  const ancho = girada ? altoBruto : anchoBruto;
  const alto = girada ? anchoBruto : altoBruto;
  const paginas = meta.pages ?? 1;
  const pixeles = ancho * alto;
  const base = { ancho, alto, formato: meta.format ?? 'desconocido', orientacion, paginas, pixeles };

  if (paginas > 1 || pixeles > pixelesMaximos || !ancho || !alto) {
    return { ...base, alfa: !!meta.hasAlpha, medidas: null, ms: Date.now() - inicio };
  }

  const opc = { failOn: 'none' as const, limitInputPixels: pixelesMaximos };

  if (meta.hasAlpha) {
    // Muchos PNG traen canal alfa sin usarlo: solo se omite si algún píxel no es opaco.
    const { data } = await sharp(buffer, opc)
      .timeout({ seconds: segundos })
      .resize(LADO_PUBLICACION, LADO_PUBLICACION, { fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minimo = 255;
    for (let i = 0; i < data.length; i++) if (data[i] < minimo) minimo = data[i];
    if (minimo < 250) return { ...base, alfa: true, medidas: null, ms: Date.now() - inicio };
  }

  const { data, info } = await sharp(buffer, opc)
    .timeout({ seconds: segundos })
    .rotate()
    .flatten({ background: BLANCO })
    .resize(LADO_PUBLICACION, LADO_PUBLICACION, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sinReducir = info.width === ancho && info.height === alto;
  const medidas = medir(data, info.width, info.height, info.channels, sinReducir);
  return { ...base, alfa: false, medidas, ms: Date.now() - inicio };
}

/**
 * Valor absoluto sin `Math.abs`: en los bucles por píxel se llama millones de veces. En Node da igual
 * (V8 lo optimiza), pero bajo Jest las llamadas a `Math.*` eran 50–100 veces más lentas y cada spec
 * tardaba 40 s; con esta función en línea, ambos van igual de rápido.
 */
const abs = (v: number) => (v < 0 ? -v : v);

function percentil(hist: Uint32Array, total: number, p: number): number {
  let acumulado = 0;
  const objetivo = total * p;
  for (let i = 0; i < hist.length; i++) {
    acumulado += hist[i];
    if (acumulado >= objetivo) return i;
  }
  return hist.length - 1;
}

/**
 * Medidas sobre RGB crudo (`ch` canales, 3 o 4), ya girado y aplanado. Fórmulas del anexo del plan,
 * tal como se midieron en el prototipo; solo se añaden blanco/negro y color por zona para la verificación.
 */
export function medir(entrada: Buffer | Uint8Array, w: number, h: number, ch: number, sinReducir: boolean): MedidasImagen {
  return medirConMascara(entrada, w, h, ch, sinReducir).medidas;
}

/**
 * Igual que `medir`, y además devuelve la máscara del sujeto (1 = sujeto). Si se pasa `mascaraDada`
 * (de otra imagen del MISMO tamaño), se usa esa en vez de calcularla: así la verificación cuenta el
 * blanco, el negro y el color en los mismos píxeles antes y después (si el sujeto se quema, se
 * parece al fondo y una máscara recalculada lo dejaría fuera).
 */
export function medirConMascara(
  entrada: Buffer | Uint8Array, w: number, h: number, ch: number, sinReducir: boolean, mascaraDada?: Uint8Array,
): { medidas: MedidasImagen; mascara: Uint8Array } {
  // Vista propia sobre la misma memoria (sin copiar): el acceso por índice a un Uint8Array simple es
  // monomórfico y bastante más rápido que sobre un Buffer de otro contexto (por ejemplo, bajo Jest).
  const data = new Uint8Array(entrada.buffer, entrada.byteOffset, entrada.length);
  const n = w * h;
  const Y = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let tr = 0, tg = 0, tb = 0;
  for (let i = 0, j = 0; i < n; i++, j += ch) {
    const y = (77 * data[j] + 150 * data[j + 1] + 29 * data[j + 2] + 128) >> 8;
    Y[i] = y;
    hist[y]++;
    tr += data[j]; tg += data[j + 1]; tb += data[j + 2];
  }
  const p1 = percentil(hist, n, 0.01);
  const p50 = percentil(hist, n, 0.5);
  const p99 = percentil(hist, n, 0.99);
  const p995 = percentil(hist, n, 0.995);
  const rango = Math.max(1, p99 - p1);
  let blancos = 0, negros = 0;
  for (let i = 0; i <= 3; i++) negros += hist[i];
  for (let i = 252; i < 256; i++) blancos += hist[i];

  // Fondo: mediana por canal del anillo exterior (3 % del lado menor) y qué parte del anillo se le parece.
  // La tolerancia sigue al contraste: con una fija, una foto oscura parecía tener fondo liso.
  const t = Math.max(2, Math.round(0.03 * Math.min(w, h)));
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  let nb = 0;
  const anillo = (fn: (j: number) => void) => {
    for (let y = 0; y < h; y++) {
      const borde = y < t || y >= h - t;
      for (let x = 0; x < w; x++) {
        if (!borde && x === t) x = Math.max(t, w - t);
        if (x >= w) break;
        fn((y * w + x) * ch);
      }
    }
  };
  anillo((j) => { hr[data[j]]++; hg[data[j + 1]]++; hb[data[j + 2]]++; nb++; });
  const fr = percentil(hr, nb, 0.5), fg = percentil(hg, nb, 0.5), fb = percentil(hb, nb, 0.5);
  const tol = Math.max(6, Math.min(18, (18 * rango) / 220));
  const dist = (j: number) => {
    const a = abs(data[j] - fr), b = abs(data[j + 1] - fg), c = abs(data[j + 2] - fb);
    return a > b ? (a > c ? a : c) : (b > c ? b : c);
  };
  let parecidos = 0;
  anillo((j) => { if (dist(j) <= tol) parecidos++; });
  const fondo = {
    r: fr, g: fg, b: fb,
    L: (77 * fr + 150 * fg + 29 * fb) / 256,
    uniformidad: nb ? parecidos / nb : 0,
    tinte: Math.max(fr, fg, fb) - Math.min(fr, fg, fb),
  };

  // Sujeto: lo que se aleja del fondo. Caja = primera/última fila y columna con suficientes píxeles de sujeto.
  const filas = new Uint32Array(h), cols = new Uint32Array(w), histS = new Uint32Array(256);
  const tolS = tol * 1.55;
  const usarDada = !!mascaraDada && mascaraDada.length === w * h;
  const mascara = usarDada ? mascaraDada! : new Uint8Array(w * h);
  let sujeto = 0, sr = 0, sg = 0, sb = 0, blancosS = 0, negrosS = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * ch;
      const esSujeto = usarDada ? mascara[i] === 1 : dist(j) > tolS;
      if (esSujeto) {
        if (!usarDada) mascara[i] = 1;
        filas[y]++; cols[x]++; sujeto++;
        const yy = Y[i];
        histS[yy]++;
        if (yy >= 252) blancosS++; else if (yy <= 3) negrosS++;
        sr += data[j]; sg += data[j + 1]; sb += data[j + 2];
      }
    }
  }
  const p1Sujeto = sujeto ? percentil(histS, sujeto, 0.01) : p1;
  const p99Sujeto = sujeto ? percentil(histS, sujeto, 0.99) : p99;
  const minF = Math.max(2, 0.006 * w), minC = Math.max(2, 0.006 * h);
  let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
  while (y0 < h - 1 && filas[y0] < minF) y0++;
  while (y1 > y0 && filas[y1] < minF) y1--;
  while (x0 < w - 1 && cols[x0] < minC) x0++;
  while (x1 > x0 && cols[x1] < minC) x1--;
  const caja = { x0: x0 / w, x1: (x1 + 1) / w, y0: y0 / h, y1: (y1 + 1) / h };
  const ocupacion = ((x1 - x0 + 1) * (y1 - y0 + 1)) / n;

  // Agudeza: |laplaciano| ÷ gradiente sobre el 10 % de píxeles con más gradiente. No cambia al aclarar
  // ni al lavar (a diferencia de la varianza del laplaciano, que se confundía con contraste y grano).
  let agudeza = 0;
  if (w >= 3 && h >= 3) {
    const hG = new Uint32Array(1024);
    const G = new Uint16Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const g = abs(Y[i + 1] - Y[i - 1]) + abs(Y[i + w] - Y[i - w]);
        G[i] = g; hG[g]++;
      }
    }
    const m = (w - 2) * (h - 2);
    const umbral = Math.max(12 * Math.min(1, rango / 200) + 2, percentil(hG, m, 0.9));
    let aL = 0, aG = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (G[i] >= umbral) {
          aL += abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w]);
          aG += G[i];
        }
      }
    }
    agudeza = aG ? aL / aG : 0;
  }

  // Ruido: residuo de Immerkær por bloque de 8×8; se saltan los bloques quemados; percentil 10.
  const estimaciones: number[] = [];
  let bloquesTotales = 0;
  for (let by = 1; by + 9 <= h; by += 8) {
    for (let bx = 1; bx + 9 <= w; bx += 8) {
      bloquesTotales++;
      let s = 0, recortados = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (by + y) * w + bx + x;
          const v = Y[i];
          if (v >= 253 || v <= 2) recortados++;
          s += abs(Y[i - w - 1] - 2 * Y[i - w] + Y[i - w + 1] - 2 * Y[i - 1] + 4 * v - 2 * Y[i + 1] + Y[i + w - 1] - 2 * Y[i + w] + Y[i + w + 1]);
        }
      }
      if (recortados > 12) continue;
      estimaciones.push((1.2533 * s) / (6 * 64));
    }
  }
  estimaciones.sort((a, b) => a - b);
  const ruido = estimaciones.length >= Math.max(20, bloquesTotales * 0.04)
    ? estimaciones[Math.floor(estimaciones.length * 0.1)]
    : null;

  // Cuadritos de JPEG: salto en las fronteras de 8 px frente al salto a mitad de bloque. Solo tiene
  // sentido a tamaño original (al reducir, la rejilla desaparece).
  let bloques: number | null = null, bloquesDif: number | null = null;
  if (sinReducir && w > 64 && h > 64) {
    let a = 0, na = 0, b = 0, nb2 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 8; x < w; x++) {
        const k = x & 7;
        if (k !== 0 && k !== 4) continue;
        const d = abs(Y[y * w + x] - Y[y * w + x - 1]);
        if (k === 0) { a += d; na++; } else { b += d; nb2++; }
      }
    }
    for (let y = 8; y < h; y++) {
      const k = y & 7;
      if (k !== 0 && k !== 4) continue;
      for (let x = 0; x < w; x++) {
        const d = abs(Y[y * w + x] - Y[(y - 1) * w + x]);
        if (k === 0) { a += d; na++; } else { b += d; nb2++; }
      }
    }
    const fa = na ? a / na : 0, fb2 = nb2 ? b / nb2 : 0;
    bloques = fa / Math.max(0.05, fb2);
    bloquesDif = fa - fb2;
  }

  const medidas: MedidasImagen = {
    w, h, p1, p50, p99, p995, rango, fondo, caja, ocupacion,
    sujetoFrac: sujeto / n, p1Sujeto, p99Sujeto, agudeza, ruido, bloques, bloquesDif,
    blancoTotal: blancos / n,
    negroTotal: negros / n,
    blancoSujeto: sujeto ? blancosS / sujeto : 0,
    negroSujeto: sujeto ? negrosS / sujeto : 0,
    colorSujeto: sujeto ? { r: sr / sujeto, g: sg / sujeto, b: sb / sujeto } : null,
    colorTotal: { r: tr / n, g: tg / n, b: tb / n },
  };
  return { medidas, mascara };
}
