/** Cómo se registra un error en el log del servidor. */
export type NivelRegistro = 'error' | 'advertencia' | 'ninguno';

/** Resultado de traducir cualquier excepción a una respuesta HTTP uniforme. */
export interface ErrorTraducido {
  readonly estado: number;
  /** Código estable que lee el front (`error.error.codigo`). */
  readonly codigo: string;
  /** Texto en español; arreglo solo en errores de validación (como hasta ahora). */
  readonly mensaje: string | string[];
  /** Frase corta del campo `error`; si falta se usa la del estado HTTP. */
  readonly error?: string;
  /** Campos adicionales del cuerpo (detalle del error de dominio, `campos`, etc.). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Segundos sugeridos para reintentar: se envían en la cabecera Retry-After. */
  readonly reintentarEnSeg?: number;
  readonly registro: NivelRegistro;
  /** Detalle técnico SOLO para el log (nunca se envía al cliente ni lleva datos personales). */
  readonly detalleLog?: string;
}

/** Estrategia de traducción: devuelve null si el error no es de su tipo. */
export interface TraductorError {
  traducir(error: unknown): ErrorTraducido | null;
}
