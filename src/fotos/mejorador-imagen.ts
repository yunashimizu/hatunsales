import sharp from 'sharp';
import { configurarSharp } from '../util/storage/redimensionador-imagen';
import { analizarImagen, AnalisisImagen, MedidasImagen, medirConMascara } from './analizador-imagen';
import { decidirReceta, RecetaMejora } from './receta-mejora';
import { ENFOQUES, UMBRALES_MEJORA, UmbralesMejora } from './umbrales-mejora';

/**
 * Aplica una receta a una foto y comprueba que el resultado no empeoró
 * (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §5.3 y §5.4).
 *
 * Tres llamadas a libvips, en orden fijo (libvips reordena las operaciones de una misma llamada):
 *   1. geometría: recorte + giro EXIF + reducir/ampliar, en UNA llamada que ya baja de tamaño
 *      (nunca se saca la imagen entera en crudo: así una foto de 24 Mpx no dispara la memoria);
 *   2. tono: niveles, ANTES del enfoque (si no, la ganancia multiplica los halos);
 *   3. detalle: mediana o suavizado leve si toca → enfoque → JPEG calidad 90, croma 4:4:4, sin mozjpeg
 *      (mozjpeg tardó 280–590 ms por foto frente a 29–71 ms, para un 17–29 % menos de peso).
 */

export interface ImagenMejorada {
  buffer: Buffer;
  ancho: number;
  alto: number;
  /**
   * Medidas de la foto tras la geometría (recorte y tamaño) y ANTES del tono y el detalle. Es la
   * referencia justa para la verificación: compara la misma imagen, del mismo tamaño, con y sin
   * corrección. Solo se calcula si se pide (`medirBase`).
   */
  base?: MedidasImagen;
  /** Máscara del sujeto de `base` (uso interno de la verificación). */
  mascaraBase?: Uint8Array;
}

/**
 * Límites de la verificación posterior. El plan los dejó propuestos sin medir (agudeza 0,03, blanco 2,
 * negro 1, razones de color 6 %). En la tanda B1, sobre las 114 muestras y comparando contra la misma
 * geometría sin corregir, las 74 correcciones aceptadas (todas miradas en hojas antes/después) llegaron
 * como mucho a: agudeza −0,034 (aclarar una oscura con grano), blanco del sujeto +1,6 puntos (lavada),
 * negro del sujeto +1,8 (ampliar una chica: el borde oscuro de un mango), desvío de color 1,2 niveles
 * (16,4 con balance). Los límites quedan por encima de eso y por debajo de un daño real, que se prueba
 * en mejorador-imagen.spec.ts (ganancia que quema, tinte que aparece, suavizado que borra detalle).
 */
export const LIMITES_VERIFICACION = Object.freeze({
  /** La agudeza no puede bajar más que esto (salvo con la mediana, que la baja a propósito). */
  caidaAgudeza: 0.05,
  /** Puntos porcentuales que puede subir el blanco puro (≥ 252) del sujeto (o de la imagen, sin sujeto). */
  subidaBlanco: 2.5,
  /** Puntos porcentuales que puede subir el negro puro (≤ 3) del sujeto (o de la imagen, sin sujeto). */
  subidaNegro: 2.5,
  /**
   * Cuánto puede desviarse el color medio (del sujeto y de la imagen entera) de lo que daría la misma
   * ganancia en los tres canales, en niveles de 0–255 sobre los ejes oponentes R−G y (R+G)/2−B. Con
   * balance de blancos se busca justamente mover el color, y el margen es mayor.
   */
  desvioColor: 6,
  desvioColorBalance: 30,
  /** La mediana sobre grano fuerte corrige el sesgo de color del grano recortado en 0 y 255: margen mayor. */
  desvioColorRuido: 12,
});

const OPCIONES_ENTRADA = (umbrales: UmbralesMejora) => ({ failOn: 'none' as const, limitInputPixels: umbrales.pixelesMaximos });

/**
 * Pasa un recorte expresado en la imagen YA girada (como lo ve la persona) a las coordenadas del
 * archivo guardado, según la orientación EXIF. Así el recorte se hace ANTES de girar y de reducir,
 * en la misma llamada que reduce.
 */
export function recorteSinGirar(
  recorte: { left: number; top: number; width: number; height: number },
  orientacion: number,
  anchoVisto: number,
  altoVisto: number,
): { left: number; top: number; width: number; height: number } {
  const { left: x, top: y, width: w, height: h } = recorte;
  const W = anchoVisto, H = altoVisto;
  switch (orientacion) {
    case 2: return { left: W - x - w, top: y, width: w, height: h };
    case 3: return { left: W - x - w, top: H - y - h, width: w, height: h };
    case 4: return { left: x, top: H - y - h, width: w, height: h };
    case 5: return { left: y, top: x, width: h, height: w };
    case 6: return { left: y, top: W - x - w, width: h, height: w };
    case 7: return { left: H - y - h, top: W - x - w, width: h, height: w };
    case 8: return { left: H - y - h, top: x, width: h, height: w };
    default: return { left: x, top: y, width: w, height: h };
  }
}

export async function aplicarReceta(
  buffer: Buffer,
  receta: RecetaMejora,
  umbrales: UmbralesMejora = UMBRALES_MEJORA,
  orientacion?: number,
  medirBase = false,
): Promise<ImagenMejorada> {
  configurarSharp();
  const segundos = umbrales.segundosPorLlamada;

  // 1. Geometría.
  let geometria = sharp(buffer, OPCIONES_ENTRADA(umbrales)).timeout({ seconds: segundos });
  if (receta.recorte) {
    let orient = orientacion;
    let anchoVisto = 0, altoVisto = 0;
    const meta = await sharp(buffer, { failOn: 'none', limitInputPixels: false }).metadata();
    orient = orient ?? meta.orientation ?? 1;
    const girada = orient >= 5;
    anchoVisto = (girada ? meta.height : meta.width) ?? 0;
    altoVisto = (girada ? meta.width : meta.height) ?? 0;
    geometria = geometria.extract(recorteSinGirar(receta.recorte, orient, anchoVisto, altoVisto));
  }
  geometria = geometria.rotate().flatten({ background: { r: 255, g: 255, b: 255 } });
  if (receta.escala !== 1) {
    geometria = geometria.resize(receta.anchoSalida, receta.altoSalida, { fit: 'fill', kernel: 'lanczos3' });
  }
  let { data, info } = await geometria.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const crudo = () => ({ raw: { width: info.width, height: info.height, channels: info.channels as 3 } });
  const medidaBase = medirBase ? medirConMascara(data, info.width, info.height, info.channels, false) : undefined;

  // 2. Tono.
  if (receta.lineal) {
    ({ data, info } = await sharp(data, crudo())
      .timeout({ seconds: segundos })
      .linear(receta.lineal.a, receta.lineal.b)
      .raw()
      .toBuffer({ resolveWithObject: true }));
  }

  // 3. Detalle y codificación.
  let fin = sharp(data, crudo()).timeout({ seconds: segundos });
  if (receta.suavizar === 'mediana') fin = fin.median(3);
  else if (receta.suavizar === 'leve') fin = fin.blur(0.6);
  if (receta.enfoque) fin = fin.sharpen(ENFOQUES[receta.enfoque]);
  const salida = await fin.jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
  return { buffer: salida, ancho: info.width, alto: info.height, base: medidaBase?.medidas, mascaraBase: medidaBase?.mascara };
}

export interface ResultadoVerificacion {
  ok: boolean;
  motivo?: 'agudeza' | 'blanco' | 'negro' | 'color';
  detalle: { caidaAgudeza: number; subidaBlanco: number; subidaNegro: number; desvioColor: number };
}

/**
 * «No hacer daño»: compara la foto con y sin las correcciones de tono y detalle (`antes` debe ser la
 * medida de la MISMA geometría: `ImagenMejorada.base`). Así el recorte o el cambio de tamaño no se
 * confunden con un daño, y las cuatro medidas comparan lo mismo.
 *
 * Desvíos del plan (§5.4), medidos en la tanda B1:
 * - El blanco y el negro puros se cuentan en el sujeto con la máscara de ANTES (`medirConMascara`): el
 *   sujeto se define por su distancia al fondo, y al quemarse se funde con el fondo; con una máscara
 *   recalculada una ganancia ×2,2 que quemaba media figura pasaba la verificación. En la imagen entera
 *   tampoco sirve: una foto lavada sobre blanco puro vuelve, con razón, a tener el fondo en blanco puro.
 * - El color no se compara por las razones R/G y B/G: el desplazamiento igual en los tres canales de una
 *   foto lavada las cambia sin cambiar el color. Se mide en ejes oponentes (R−G, (R+G)/2−B), que no se
 *   mueven con un desplazamiento igual y escalan con la ganancia: se compara el color de después con el
 *   de antes multiplicado por la ganancia de la receta. Detecta tanto un giro de tono como un tinte que
 *   aparece en una foto gris (el ángulo no lo veía: sin croma no hay tono).
 */
export function verificarMejora(antes: MedidasImagen, despues: MedidasImagen, receta: RecetaMejora): ResultadoVerificacion {
  const L = LIMITES_VERIFICACION;
  const caidaAgudeza = antes.agudeza - despues.agudeza;
  // En el sujeto si lo hay (con la misma máscara en las dos medidas), si no en la imagen entera.
  const porSujeto = antes.sujetoFrac >= 0.02;
  const subidaBlanco = ((porSujeto ? despues.blancoSujeto - antes.blancoSujeto : despues.blancoTotal - antes.blancoTotal)) * 100;
  const subidaNegro = ((porSujeto ? despues.negroSujeto - antes.negroSujeto : despues.negroTotal - antes.negroTotal)) * 100;
  const ganancia = receta.lineal ? (receta.lineal.a[0] + receta.lineal.a[1] + receta.lineal.a[2]) / 3 : 1;
  const desvioColor = Math.max(
    desvio(antes.colorTotal, despues.colorTotal, ganancia),
    antes.colorSujeto && despues.colorSujeto ? desvio(antes.colorSujeto, despues.colorSujeto, ganancia) : 0,
  );
  const detalle = { caidaAgudeza, subidaBlanco, subidaNegro, desvioColor };

  // La mediana baja la agudeza a propósito (quita grano, que la medida confunde con detalle).
  if (!receta.acciones.includes('RUIDO') && caidaAgudeza > L.caidaAgudeza) return { ok: false, motivo: 'agudeza', detalle };
  if (subidaBlanco > L.subidaBlanco) return { ok: false, motivo: 'blanco', detalle };
  if (subidaNegro > L.subidaNegro) return { ok: false, motivo: 'negro', detalle };
  const limiteColor = receta.acciones.includes('BALANCE') ? L.desvioColorBalance
    : receta.acciones.includes('RUIDO') ? L.desvioColorRuido : L.desvioColor;
  if (desvioColor > limiteColor) return { ok: false, motivo: 'color', detalle };
  return { ok: true, detalle };
}

type Color = { r: number; g: number; b: number };

/** Distancia entre el color de después y el de antes × ganancia, en los ejes oponentes. */
function desvio(a: Color, d: Color, ganancia: number): number {
  const o1 = (c: Color) => c.r - c.g;
  const o2 = (c: Color) => (c.r + c.g) / 2 - c.b;
  return Math.hypot(o1(d) - ganancia * o1(a), o2(d) - ganancia * o2(a));
}

/**
 * Aplica la receta y la verifica contra la misma geometría sin corregir (ver `verificarMejora`). La
 * mejorada se mide tal como se publicará, ya en JPEG, con la máscara del sujeto de la base.
 */
export async function aplicarYVerificar(
  buffer: Buffer,
  receta: RecetaMejora,
  umbrales: UmbralesMejora = UMBRALES_MEJORA,
  orientacion?: number,
): Promise<{ mejorada: ImagenMejorada; despues: MedidasImagen; verificacion: ResultadoVerificacion }> {
  const mejorada = await aplicarReceta(buffer, receta, umbrales, orientacion, true);
  const decodificada = await sharp(mejorada.buffer).timeout({ seconds: umbrales.segundosPorLlamada }).raw().toBuffer({ resolveWithObject: true });
  const { info } = decodificada;
  const despues = medirConMascara(decodificada.data, info.width, info.height, info.channels, false, mejorada.mascaraBase).medidas;
  const verificacion = verificarMejora(mejorada.base!, despues, receta);
  delete mejorada.base;
  delete mejorada.mascaraBase;
  return { mejorada, despues, verificacion };
}

export interface ResultadoMejora {
  /** `mejorada`: hay archivo nuevo para publicar. `sin_cambios`: se publica la original tal cual. */
  estado: 'mejorada' | 'sin_cambios' | 'omitida';
  analisis: AnalisisImagen;
  receta: RecetaMejora;
  mejorada?: ImagenMejorada;
  despues?: MedidasImagen;
  verificacion?: ResultadoVerificacion;
  motivo?: 'verificacion' | 'animada' | 'transparencia' | 'demasiado_grande';
  ms: { analisis: number; mejora: number };
}

/**
 * Analiza, decide, aplica y verifica. Puede lanzar (archivo corrupto, tiempo agotado): quien la usa
 * (MejoraFotosService, tanda B2) captura y publica la original.
 */
export async function mejorarImagen(buffer: Buffer, umbrales: UmbralesMejora = UMBRALES_MEJORA): Promise<ResultadoMejora> {
  const analisis = await analizarImagen(buffer, umbrales);
  const receta = decidirReceta(analisis, umbrales);
  if (receta.omitida) {
    return { estado: 'omitida', analisis, receta, motivo: receta.omitida, ms: { analisis: analisis.ms, mejora: 0 } };
  }
  if (!receta.cambia) return { estado: 'sin_cambios', analisis, receta, ms: { analisis: analisis.ms, mejora: 0 } };

  const inicio = Date.now();
  const { mejorada, despues, verificacion } = await aplicarYVerificar(buffer, receta, umbrales, analisis.orientacion);
  const ms = { analisis: analisis.ms, mejora: Date.now() - inicio };
  if (!verificacion.ok) {
    return { estado: 'sin_cambios', analisis, receta, despues, verificacion, motivo: 'verificacion', ms };
  }
  return { estado: 'mejorada', analisis, receta, mejorada, despues, verificacion, ms };
}
