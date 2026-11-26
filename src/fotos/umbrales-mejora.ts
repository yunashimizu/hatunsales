/**
 * Umbrales de la mejora automática de fotos de producto (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §5.2).
 *
 * Son valores de partida MEDIDOS sobre 114 muestras (10 fotos reales + degradaciones a propósito); al lado
 * de cada uno va lo que se midió. Se pueden pisar sin tocar código con variables de entorno `FOTOS_<CLAVE>`
 * (por ejemplo `FOTOS_AGUDEZA_NITIDA=0.34`). Si cambian de forma que altere el resultado, se sube
 * VERSION_MEJORA: así el lote puede reprocesar solo las de la versión anterior, y nunca solo.
 */

/** Versión del algoritmo. Se guarda en cada foto procesada. */
export const VERSION_MEJORA = 1;

/** Lado mayor con el que se mide y se publica. Reducir a este lado por sí solo no cuenta como corrección. */
export const LADO_PUBLICACION = 1600;

export interface UmbralesMejora {
  /** < 480 px de lado mayor: «muy chica» (aviso fuerte). */
  ladoMuyChica: number;
  /** 480–899 px: «chica». Por debajo se amplía. Las 8 reales buenas medían ≥ 900. */
  ladoChica: number;
  /** Lado al que se lleva una foto chica al ampliarla… */
  ladoObjetivoAmpliacion: number;
  /** …sin pasar de ×2 (más es inventar píxeles sin ganar nada). */
  factorMaxAmpliacion: number;

  /** Agudeza ≥ 0,36 es nítida. Fotos normales 0,40–0,77 (también oscuras o lavadas: 0,38–0,77); σ 1,2: 0,19–0,25. */
  agudezaNitida: number;
  /** < 0,18 es «borrosa»: σ 2,5 dio 0,10–0,14 y no se recupera; se enfoca «medio» y se avisa. */
  agudezaBorrosa: number;

  /** Ruido × ganancia ≥ 5: no se enfoca (o «ligero» si además está suave). Normales 0–1,9 (celular sobre madera 4,4–5,6). */
  ruidoVisible: number;
  /** ≥ 11: mediana 3 y aviso. σ 12 dio 6,7–8,9; σ 28 dio 14,5–15,9. */
  ruidoFuerte: number;

  /** Cuadritos de JPEG: razón ≥ 1,6 y diferencia ≥ 0,85. Normales hasta 1,54 / 0,72; calidad 15: 1,68–4,40 / 0,86–6,09. */
  bloquesRazon: number;
  bloquesDif: number;
  /** Razón ≥ 2,0: además se avisa «muy comprimida». */
  bloquesAviso: number;

  /** Fondo «liso» (para balance y para medir el negro sobre el sujeto). Con fondo liso: 0,77–1,00; sin: 0,03–0,41. */
  fondoUniforme: number;
  /** Fondo liso exigido para recortar. */
  fondoParaRecorte: number;
  /** Se recorta si el sujeto ocupa menos de esto (normales 0,59–0,95; con borde añadido 0,16–0,39)… */
  ocupacionRecorte: number;
  /** …y más que esto (menos es ruido o una mota, no un producto). */
  ocupacionMinima: number;
  /** Margen que se deja alrededor del sujeto, en fracción de su lado mayor. */
  margenRecorte: number;

  /** p99 < 150: oscura (normales 161–255; oscuras 67–107). */
  p99Oscura: number;
  /** p1 ≥ 60 y rango < 150: lavada (normales p1 7–56, rango 128–247; lavadas p1 79–103, rango 64–123). */
  p1Lavada: number;
  rangoLavada: number;
  /** Tope de ganancia al aclarar (las oscuras de la prueba pidieron 2,3–2,5). */
  gananciaMax: number;
  /** Tope de ganancia al devolver contraste: con ganancia libre quedaban más duras que la foto real. */
  gananciaMaxContraste: number;
  /** Negro al que se lleva una foto lavada (no a 0: se vería duro). */
  negroObjetivo: number;
  /** Blanco al que se lleva el p99,5. */
  blancoObjetivo: number;
  /** Con ganancia ≥ esto la foto era «muy oscura» y se avisa. */
  gananciaAvisoOscura: number;

  /** Balance de blancos: fondo claro (L ≥ 185), tinte entre 13 y 40 y cálido (R ≥ G ≥ B), corregido al 60 %. */
  fondoClaroMin: number;
  fondoClaroMax: number;
  tinteNeutro: number;
  tinteMax: number;
  fuerzaBalance: number;

  /** «Fondo blanco» (blanquear fondos gris claro): APAGADO por defecto (§14 del plan: aclara el producto un 22 %). */
  fondoBlanco: boolean;
  gananciaFondoMax: number;

  /** Más de esto no se mejora (`omitida: demasiado_grande`) y ni se decodifica entera: 24 Mpx dio 201 MB de pico. */
  pixelesMaximos: number;
  /** Tope de tiempo de cada llamada a libvips. */
  segundosPorLlamada: number;
}

export const UMBRALES_MEJORA: Readonly<UmbralesMejora> = Object.freeze({
  ladoMuyChica: 480,
  ladoChica: 900,
  ladoObjetivoAmpliacion: 1000,
  factorMaxAmpliacion: 2,
  agudezaNitida: 0.36,
  agudezaBorrosa: 0.18,
  ruidoVisible: 5,
  ruidoFuerte: 11,
  bloquesRazon: 1.6,
  bloquesDif: 0.85,
  bloquesAviso: 2.0,
  fondoUniforme: 0.75,
  fondoParaRecorte: 0.9,
  ocupacionRecorte: 0.55,
  ocupacionMinima: 0.03,
  margenRecorte: 0.06,
  p99Oscura: 150,
  p1Lavada: 60,
  rangoLavada: 150,
  gananciaMax: 2.5,
  gananciaMaxContraste: 2.0,
  negroObjetivo: 12,
  blancoObjetivo: 250,
  gananciaAvisoOscura: 1.9,
  fondoClaroMin: 185,
  fondoClaroMax: 247,
  tinteNeutro: 12,
  tinteMax: 40,
  fuerzaBalance: 0.6,
  fondoBlanco: false,
  gananciaFondoMax: 1.25,
  pixelesMaximos: 25_000_000,
  segundosPorLlamada: 20,
});

/**
 * Enfoques probados. Con `sigma`, libvips enfoca solo la luminancia (L de LAB) y `y2`/`y3` limitan
 * cuánto puede aclarar u oscurecer un borde (el halo), en unidades de L* (0–100), no de 0–255. Nunca se
 * usa uno más ancho: con σ 2,2 se vieron halos claros entre piezas.
 *
 * «medio» (tanda B1): el plan traía `y2: 12, y3: 20`, que en un escalón 60 → 200 sobrepasaba 20 y 21
 * niveles (la aceptación pide ≤ 14). Con `y2: 4, y3: 6` queda en 13 y 11, y sobre las 8 fotos con
 * desenfoque σ 1,2 la agudeza sube igual de 0,19–0,25 a 0,25–0,31 (antes 0,27–0,34).
 */
export const ENFOQUES = Object.freeze({
  ligero: { sigma: 1.0, m1: 0.3, m2: 2.0, x1: 2, y2: 10, y3: 16 },
  medio: { sigma: 1.5, m1: 0.4, m2: 3.0, x1: 2, y2: 4, y3: 6 },
  ampliacion: { sigma: 1.1, m1: 0.2, m2: 1.8, x1: 2, y2: 10, y3: 16 },
});
export type TipoEnfoque = keyof typeof ENFOQUES;

/** `agudezaNitida` → `FOTOS_AGUDEZA_NITIDA`. */
export function nombreVariable(clave: string): string {
  return 'FOTOS_' + clave.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Umbrales efectivos: los de arriba, pisados por `FOTOS_*` cuando la variable trae un valor válido.
 * Un valor que no se entiende se ignora (se queda el medido): un error de tipeo no debe estropear fotos.
 */
export function leerUmbrales(env: Record<string, string | undefined> = process.env): UmbralesMejora {
  const salida: UmbralesMejora = { ...UMBRALES_MEJORA };
  for (const clave of Object.keys(UMBRALES_MEJORA) as (keyof UmbralesMejora)[]) {
    const bruto = env[nombreVariable(clave)];
    if (bruto === undefined || bruto.trim() === '') continue;
    if (typeof UMBRALES_MEJORA[clave] === 'boolean') {
      const v = bruto.trim().toLowerCase();
      if (['1', 'true', 'si', 'sí'].includes(v)) (salida as any)[clave] = true;
      else if (['0', 'false', 'no'].includes(v)) (salida as any)[clave] = false;
      continue;
    }
    const numero = Number(bruto.replace(',', '.'));
    if (Number.isFinite(numero) && numero >= 0) (salida as any)[clave] = numero;
  }
  return salida;
}
