import type { AnalisisImagen } from './analizador-imagen';
import { LADO_PUBLICACION, UMBRALES_MEJORA, UmbralesMejora, TipoEnfoque } from './umbrales-mejora';

/**
 * Decide qué corregir a partir de las medidas (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §5.2 y anexo).
 * Es pura: no toca píxeles ni `sharp`, así se prueba con números y se puede guardar para repetirla.
 */

export type CodigoAccion = 'RECORTE' | 'AMPLIAR' | 'ACLARAR' | 'CONTRASTE' | 'BALANCE' | 'RUIDO' | 'ENFOQUE' | 'FONDO_BLANCO';
export type CodigoAviso = 'MUY_CHICA' | 'CHICA' | 'BORROSA' | 'MUY_OSCURA' | 'RUIDO' | 'COMPRIMIDA';
export type MotivoOmitida = 'animada' | 'transparencia' | 'demasiado_grande';

export interface RecetaMejora {
  /** `false` ⇒ se publica el archivo original tal cual, byte a byte. */
  cambia: boolean;
  acciones: CodigoAccion[];
  avisos: CodigoAviso[];
  omitida?: MotivoOmitida;
  /** Recorte en píxeles de la imagen YA girada por EXIF y a tamaño original. */
  recorte?: { left: number; top: number; width: number; height: number };
  /** Factor sobre el tamaño tras recortar (< 1 reduce a 1600, > 1 amplía). */
  escala: number;
  /** Medidas finales de la mejorada. */
  anchoSalida: number;
  altoSalida: number;
  /** Niveles: salida = a·entrada + b, por canal. La ganancia es la misma en R, G y B salvo el balance. */
  lineal?: { a: [number, number, number]; b: [number, number, number] };
  suavizar?: 'mediana' | 'leve';
  enfoque?: TipoEnfoque;
}

const redondear = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export function decidirReceta(analisis: AnalisisImagen, umbrales: UmbralesMejora = UMBRALES_MEJORA): RecetaMejora {
  const u = umbrales;
  const W = analisis.ancho, H = analisis.alto;
  const lado = Math.max(W, H);
  const r: RecetaMejora = { cambia: false, acciones: [], avisos: [], escala: 1, anchoSalida: W, altoSalida: H };

  // El aviso de tamaño vale aunque la foto no se pueda mejorar: quien sube lo necesita igual.
  if (lado < u.ladoMuyChica) r.avisos.push('MUY_CHICA');
  else if (lado < u.ladoChica) r.avisos.push('CHICA');

  if (analisis.paginas > 1) return { ...r, omitida: 'animada' };
  if (analisis.alfa) return { ...r, omitida: 'transparencia' };
  const a = analisis.medidas;
  if (!a || analisis.pixeles > u.pixelesMaximos) return { ...r, omitida: 'demasiado_grande' };

  // 1. Recorte del borde vacío (solo con fondo muy liso: con textura no se sabe dónde acaba el producto).
  const f = a.fondo;
  const liso = f.uniformidad >= u.fondoUniforme;
  if (f.uniformidad >= u.fondoParaRecorte && a.ocupacion < u.ocupacionRecorte && a.ocupacion > u.ocupacionMinima) {
    const bw = (a.caja.x1 - a.caja.x0) * W, bh = (a.caja.y1 - a.caja.y0) * H;
    const mg = u.margenRecorte * Math.max(bw, bh);
    const x0 = Math.max(0, Math.round(a.caja.x0 * W - mg)), y0 = Math.max(0, Math.round(a.caja.y0 * H - mg));
    const x1 = Math.min(W, Math.round(a.caja.x1 * W + mg)), y1 = Math.min(H, Math.round(a.caja.y1 * H + mg));
    if (x1 - x0 >= 8 && y1 - y0 >= 8) {
      r.recorte = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
      r.acciones.push('RECORTE');
    }
  }

  // 2. Tamaño de salida. Reducir a 1600 no cuenta como corrección.
  const anchoBase = r.recorte ? r.recorte.width : W, altoBase = r.recorte ? r.recorte.height : H;
  const ladoBase = Math.max(anchoBase, altoBase);
  if (ladoBase > LADO_PUBLICACION) r.escala = LADO_PUBLICACION / ladoBase;
  else if (ladoBase < u.ladoChica) {
    r.escala = Math.min(u.factorMaxAmpliacion, u.ladoObjetivoAmpliacion / ladoBase);
    r.acciones.push('AMPLIAR');
  }
  r.anchoSalida = Math.max(1, Math.round(anchoBase * r.escala));
  r.altoSalida = Math.max(1, Math.round(altoBase * r.escala));

  // 3. Tono. Balance solo con fondo casi blanco, cálido y liso (es la única referencia fiable).
  let g: [number, number, number] = [1, 1, 1];
  let off = 0, gan = 1;
  if (liso && f.L >= u.fondoClaroMin && f.tinte > u.tinteNeutro && f.tinte <= u.tinteMax && f.r >= f.g && f.g >= f.b) {
    const objetivo = Math.max(f.r, f.g, f.b);
    g = [f.r, f.g, f.b].map((c) => 1 + u.fuerzaBalance * (objetivo / Math.max(1, c) - 1)) as [number, number, number];
    r.acciones.push('BALANCE');
  }
  // Con fondo liso y claro, el negro se mide en el sujeto: un fondo blanco al 97 % daba un falso «lavada».
  const p1 = liso && a.sujetoFrac >= 0.02 ? Math.min(a.p1, a.p1Sujeto) : a.p1;
  const oscura = a.p99 < u.p99Oscura;
  const lavada = p1 >= u.p1Lavada && a.p99 - p1 < u.rangoLavada;
  if (oscura || lavada) {
    const negro = lavada ? Math.max(0, p1 - 6) : 0;
    const blanco = Math.max(negro + 20, a.p995);
    const base = lavada ? u.negroObjetivo : 0;
    gan = Math.min(lavada ? u.gananciaMaxContraste : u.gananciaMax, (u.blancoObjetivo - base) / (blanco - negro));
    if (lavada) {
      // Con la ganancia topada se reparte el margen: medio camino entre fijar el negro y fijar el punto medio.
      const offNegro = base - negro * gan;
      const offMedio = ((blanco + negro) / 2) * (1 - gan);
      off = offNegro + 0.5 * Math.max(0, offMedio - offNegro);
    }
    r.acciones.push(oscura && !lavada ? 'ACLARAR' : 'CONTRASTE');
    if (oscura && gan >= u.gananciaAvisoOscura) r.avisos.push('MUY_OSCURA');
  } else if (u.fondoBlanco && liso && f.L >= u.fondoClaroMin && f.L <= u.fondoClaroMax
    && (f.tinte <= u.tinteNeutro || r.acciones.includes('BALANCE'))) {
    // «Fondo blanco»: apagado por defecto (aclara también el producto).
    gan = Math.min(u.gananciaFondoMax, u.blancoObjetivo / f.L, 252 / Math.max(1, a.p99Sujeto));
    if (gan >= 1.05) r.acciones.push('FONDO_BLANCO');
    else gan = 1;
  }
  if (gan !== 1 || off !== 0 || g.some((v) => v !== 1)) {
    r.lineal = {
      a: g.map((v) => redondear(v * gan)) as [number, number, number],
      b: [redondear(off, 2), redondear(off, 2), redondear(off, 2)],
    };
  }

  // 4. Grano y cuadritos: limitan el enfoque (enfocar el grano lo empeora mucho, visto en la prueba).
  const ruidoEf = (a.ruido ?? 0) * gan;
  const comprimida = a.bloques != null && a.bloquesDif != null && a.bloques >= u.bloquesRazon && a.bloquesDif >= u.bloquesDif;
  if (ruidoEf >= u.ruidoFuerte) {
    r.suavizar = 'mediana';
    r.acciones.push('RUIDO');
    r.avisos.push('RUIDO');
  } else if (comprimida) {
    if (a.bloques! >= u.bloquesAviso) r.avisos.push('COMPRIMIDA');
  }

  // 5. Enfoque: «medio» como máximo (uno más ancho dejó halos). Con grano fuerte, ninguno (se acaba de
  // quitar con la mediana); con grano visible, solo «ligero» y solo si además está borrosa; con
  // cuadritos, «ligero» (§5.2 del plan).
  const borrosa = a.agudeza < u.agudezaBorrosa;
  const suave = a.agudeza < u.agudezaNitida;
  const conGrano = ruidoEf >= u.ruidoVisible;
  if (borrosa) r.avisos.push('BORROSA');
  let enfoque: TipoEnfoque | undefined;
  if (ruidoEf >= u.ruidoFuerte) enfoque = undefined;
  else if (conGrano) enfoque = borrosa ? 'ligero' : undefined;
  else if (suave) enfoque = comprimida ? 'ligero' : 'medio';
  if (enfoque) {
    r.enfoque = enfoque;
    r.acciones.push('ENFOQUE');
  } else if (r.escala > 1 && !conGrano && !comprimida) {
    r.enfoque = 'ampliacion';
  }
  // Con cuadritos, antes de enfocar se suavizan un poco para no marcar la rejilla.
  if (comprimida && r.enfoque && !r.suavizar) r.suavizar = 'leve';

  r.cambia = r.acciones.length > 0;
  return r;
}
