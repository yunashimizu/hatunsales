/**
 * Configuración de la Fase 7 (caja y devoluciones), en la tabla `configuraciones`. Utilidad pura: claves,
 * valores por defecto y normalización. Sin ninguna clave guardada el sistema se comporta como antes de la
 * Fase 7, salvo el bloqueo de 7.2 (anular una venta a crédito con abonos), que nace encendido (D3).
 */

export const CLAVES_CONTROL_CAJA = {
  /** 7.2 (D3): `bloquear` (por defecto) o `permitir`. */
  anulacionCreditoConAbonos: 'anulacion_credito_con_abonos',
  /** 7.3 (D4): el cajero y el vendedor no ven el efectivo esperado hasta enviar su conteo. Apagado por defecto. */
  arqueoCiego: 'arqueo_ciego',
  /** 7.4 (D8): horas de turno abierto tras las que se cierra solo. 0 (por defecto) = apagado; sugerido 16. */
  cierreAutomaticoHoras: 'caja_cierre_automatico_horas',
  /** 9.4: días de gracia de una deuda vencida antes de negar un crédito nuevo. 0 (por defecto) = apagado. */
  creditoBloqueoMoraDias: 'credito_bloqueo_mora_dias',
} as const;

/** Tope de días de gracia del bloqueo por mora (un año). */
export const MORA_DIAS_MAXIMO = 365;

export const MODOS_ANULACION_CREDITO = ['bloquear', 'permitir'] as const;
export type ModoAnulacionCredito = (typeof MODOS_ANULACION_CREDITO)[number];

/** Tope de horas del cierre automático (3 días): más que eso no es «olvidado», es otra cosa. */
export const CIERRE_AUTOMATICO_HORAS_MAXIMO = 72;
/** Mínimo cuando está encendido: un turno normal de 8 h nunca se corta. */
export const CIERRE_AUTOMATICO_HORAS_MINIMO = 8;

export interface ConfigControlCaja {
  anulacion_credito_con_abonos: ModoAnulacionCredito;
  arqueo_ciego: boolean;
  /** 0 = apagado. */
  caja_cierre_automatico_horas: number;
  /** 9.4: 0 = apagado; N > 0 = una deuda vencida hace más de N días impide un crédito nuevo. */
  credito_bloqueo_mora_dias: number;
}

export const CONTROL_CAJA_POR_DEFECTO: ConfigControlCaja = {
  anulacion_credito_con_abonos: 'bloquear',
  arqueo_ciego: false,
  caja_cierre_automatico_horas: 0,
  credito_bloqueo_mora_dias: 0,
};

function textoLimpio(valor: unknown): string {
  return String(valor ?? '').trim().toLowerCase();
}

/** Booleano guardado como texto (mismo criterio que ConfiguracionRepository.obtenerBooleano). */
export function booleanoDeTexto(valor: string | null | undefined, porDefecto: boolean): boolean {
  if (valor === null || valor === undefined || String(valor).trim() === '') return porDefecto;
  return ['true', '1', 'si', 'sí'].includes(textoLimpio(valor));
}

/** Horas válidas: 0 (apagado) o un entero entre el mínimo y el máximo. Lo inválido se lee como 0 (apagado). */
export function horasCierreDeTexto(valor: string | null | undefined): number {
  if (valor === null || valor === undefined || String(valor).trim() === '') return 0;
  const n = Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const horas = Math.round(n);
  if (horas < CIERRE_AUTOMATICO_HORAS_MINIMO) return CIERRE_AUTOMATICO_HORAS_MINIMO;
  return Math.min(horas, CIERRE_AUTOMATICO_HORAS_MAXIMO);
}

/** Días de gracia de 9.4: entero 1–365; lo vacío, inválido o ≤ 0 se lee como 0 (apagado); lo mayor, 365. */
export function diasMoraDeTexto(valor: string | null | undefined): number {
  if (valor === null || valor === undefined || String(valor).trim() === '') return 0;
  const n = Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), MORA_DIAS_MAXIMO);
}

/** Modo de 7.2: cualquier valor que no sea exactamente `permitir` bloquea (la regla nace encendida). */
export function modoAnulacionDeTexto(valor: string | null | undefined): ModoAnulacionCredito {
  return textoLimpio(valor) === 'permitir' ? 'permitir' : 'bloquear';
}

export function configControlCajaDesdeValores(valores: Record<string, string | null | undefined>): ConfigControlCaja {
  return {
    anulacion_credito_con_abonos: modoAnulacionDeTexto(valores[CLAVES_CONTROL_CAJA.anulacionCreditoConAbonos]),
    arqueo_ciego: booleanoDeTexto(valores[CLAVES_CONTROL_CAJA.arqueoCiego], false),
    caja_cierre_automatico_horas: horasCierreDeTexto(valores[CLAVES_CONTROL_CAJA.cierreAutomaticoHoras]),
    credito_bloqueo_mora_dias: diasMoraDeTexto(valores[CLAVES_CONTROL_CAJA.creditoBloqueoMoraDias]),
  };
}

/** Cuerpo de `PUT configuracion/control-caja`: todo opcional, solo cambia lo que llega. */
export interface CambioControlCaja {
  anulacion_credito_con_abonos?: unknown;
  arqueo_ciego?: unknown;
  caja_cierre_automatico_horas?: unknown;
  credito_bloqueo_mora_dias?: unknown;
}

/** Valida el cambio; devuelve solo lo que llegó. Lanza `Error` con un mensaje legible si algo no vale. */
export function validarCambioControlCaja(cambio: CambioControlCaja): Partial<ConfigControlCaja> {
  const nuevo: Partial<ConfigControlCaja> = {};
  if (cambio.anulacion_credito_con_abonos !== undefined && cambio.anulacion_credito_con_abonos !== null) {
    const modo = textoLimpio(cambio.anulacion_credito_con_abonos);
    if (!(MODOS_ANULACION_CREDITO as readonly string[]).includes(modo)) {
      throw new Error(`«anulacion_credito_con_abonos» debe ser uno de: ${MODOS_ANULACION_CREDITO.join(', ')}.`);
    }
    nuevo.anulacion_credito_con_abonos = modo as ModoAnulacionCredito;
  }
  if (cambio.arqueo_ciego !== undefined && cambio.arqueo_ciego !== null) {
    if (typeof cambio.arqueo_ciego !== 'boolean') throw new Error('«arqueo_ciego» debe ser verdadero o falso.');
    nuevo.arqueo_ciego = cambio.arqueo_ciego;
  }
  if (cambio.caja_cierre_automatico_horas !== undefined && cambio.caja_cierre_automatico_horas !== null) {
    const crudo = String(cambio.caja_cierre_automatico_horas).trim();
    const n = Number(crudo.replace(',', '.'));
    const valido =
      crudo !== '' &&
      Number.isInteger(n) &&
      (n === 0 || (n >= CIERRE_AUTOMATICO_HORAS_MINIMO && n <= CIERRE_AUTOMATICO_HORAS_MAXIMO));
    if (!valido) {
      throw new Error(
        `«caja_cierre_automatico_horas» debe ser 0 (apagado) o un número entero de horas entre ${CIERRE_AUTOMATICO_HORAS_MINIMO} y ${CIERRE_AUTOMATICO_HORAS_MAXIMO}.`,
      );
    }
    nuevo.caja_cierre_automatico_horas = n;
  }
  if (cambio.credito_bloqueo_mora_dias !== undefined && cambio.credito_bloqueo_mora_dias !== null) {
    const crudo = String(cambio.credito_bloqueo_mora_dias).trim();
    const n = Number(crudo.replace(',', '.'));
    if (crudo === '' || !Number.isInteger(n) || n < 0 || n > MORA_DIAS_MAXIMO) {
      throw new Error(`«credito_bloqueo_mora_dias» debe ser 0 (apagado) o un número entero de días entre 1 y ${MORA_DIAS_MAXIMO}.`);
    }
    nuevo.credito_bloqueo_mora_dias = n;
  }
  return nuevo;
}

/** Roles a los que el arqueo ciego les oculta el esperado (todos menos el admin). */
export function ocultaEsperadoA(rolNormalizado: string | null | undefined, arqueoCiego: boolean): boolean {
  return arqueoCiego && rolNormalizado !== 'admin';
}

/** Categorías del gasto de caja (7.5): lista corta y cerrada. */
export const CATEGORIAS_GASTO = ['transporte', 'servicios', 'compras_menores', 'devolucion', 'otro'] as const;
export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export const ETIQUETA_CATEGORIA_GASTO: Record<CategoriaGasto, string> = {
  transporte: 'Transporte',
  servicios: 'Servicios (luz, agua, internet)',
  compras_menores: 'Compras menores',
  devolucion: 'Devolución a un cliente',
  otro: 'Otro',
};
