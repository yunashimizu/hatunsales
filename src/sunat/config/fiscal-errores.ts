import { HttpException, HttpStatus } from '@nestjs/common';
import { CodigoErrorTipo } from '../../util/errores-operativos';

/**
 * Errores de dominio de la facturación electrónica directa.
 *
 * Los servicios lanzan `FiscalConfigError` (sin saber nada de HTTP) y la capa
 * web lo traduce con `aHttp` (o con ErroresFiscalesInterceptor) al cuerpo que
 * ya usa el resto del API: `{ statusCode, message, codigo, ...detalle }`.
 */

/**
 * Códigos de la emisión directa en BETA y PRODUCCIÓN (PLAN V3). Viven aquí porque el catálogo general
 * (util/errores-operativos.ts) es de otro módulo; el filtro global los serializa igual (usa estadoHttp).
 */
export const CODIGOS_FISCALES_EMISION = [
  'FISCAL_CERT_RUC_SIN_CONFIRMAR',
  'FISCAL_SOL_RUC_NO_COINCIDE',
  'FISCAL_AMBIENTE_CAMBIO',
  'FISCAL_NUMERO_OCUPADO',
  'FISCAL_CONSULTA_NO_DISPONIBLE',
  'FISCAL_CONFIRMACION_NO_PERMITIDA',
  'FISCAL_BETA_POS_APAGADO',
  'FISCAL_EMISION_INACTIVA',
  'FISCAL_EMISION_BLOQUEADA',
  'FISCAL_LECTURA_ERROR',
] as const;

export type CodigoFiscal = Extract<CodigoErrorTipo, `FISCAL_${string}`> | (typeof CODIGOS_FISCALES_EMISION)[number];

const ESTADO_HTTP: Record<CodigoFiscal, number> = {
  FISCAL_CERT_FORMATO_INVALIDO: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_FORMATO_NO_SOPORTADO: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_CLAVE_INCORRECTA: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_SIN_CLAVE_PRIVADA: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_VENCIDO: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_AUTOFIRMADO: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_CLAVE_DEBIL: HttpStatus.BAD_REQUEST,
  FISCAL_CONFIG_INVALIDA: HttpStatus.BAD_REQUEST,
  FISCAL_VALIDACION_CPE: HttpStatus.BAD_REQUEST,
  FISCAL_NOTA_SIN_REFERENCIA: HttpStatus.BAD_REQUEST,
  FISCAL_CERT_NO_CARGADO: HttpStatus.NOT_FOUND,
  FISCAL_DOC_NO_ENCONTRADO: HttpStatus.NOT_FOUND,
  FISCAL_XML_NO_DISPONIBLE: HttpStatus.NOT_FOUND,
  FISCAL_CDR_NO_DISPONIBLE: HttpStatus.NOT_FOUND,
  FISCAL_NO_LISTO: HttpStatus.CONFLICT,
  FISCAL_SOLO_BETA: HttpStatus.CONFLICT,
  FISCAL_CERT_EN_USO: HttpStatus.CONFLICT,
  FISCAL_CREDENCIALES_EN_USO: HttpStatus.CONFLICT,
  FISCAL_REENVIO_NO_PERMITIDO: HttpStatus.CONFLICT,
  FISCAL_ENVIO_EN_CURSO: HttpStatus.CONFLICT,
  FISCAL_DOC_OTRO_PROVEEDOR: HttpStatus.CONFLICT,
  FISCAL_ANULAR_REQUIERE_NC: HttpStatus.CONFLICT,
  FISCAL_ANULACION_FUERA_DE_PLAZO: HttpStatus.CONFLICT,
  FISCAL_NOTA_EXCEDE_MONTO: HttpStatus.CONFLICT,
  FISCAL_CERT_DEMASIADO_GRANDE: HttpStatus.PAYLOAD_TOO_LARGE,
  FISCAL_CERT_RUC_NO_COINCIDE: HttpStatus.UNPROCESSABLE_ENTITY,
  FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_SECRETO_ILEGIBLE: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_CREDENCIALES_SOL_FALTAN: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_CREDENCIALES_GRE_FALTAN: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_SUNAT_NO_DISPONIBLE: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_MIGRACION_PENDIENTE: HttpStatus.SERVICE_UNAVAILABLE,
  // Informativo (resultado de emisión); si llegara a lanzarse, es un conflicto de negocio.
  FISCAL_SUNAT_RECHAZO: HttpStatus.CONFLICT,
  // Emisión directa multi-ambiente.
  FISCAL_CERT_RUC_SIN_CONFIRMAR: HttpStatus.UNPROCESSABLE_ENTITY,
  FISCAL_SOL_RUC_NO_COINCIDE: HttpStatus.UNPROCESSABLE_ENTITY,
  FISCAL_AMBIENTE_CAMBIO: HttpStatus.CONFLICT,
  FISCAL_NUMERO_OCUPADO: HttpStatus.CONFLICT,
  FISCAL_CONSULTA_NO_DISPONIBLE: HttpStatus.CONFLICT,
  FISCAL_CONFIRMACION_NO_PERMITIDA: HttpStatus.CONFLICT,
  FISCAL_BETA_POS_APAGADO: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_EMISION_INACTIVA: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_EMISION_BLOQUEADA: HttpStatus.SERVICE_UNAVAILABLE,
  FISCAL_LECTURA_ERROR: HttpStatus.SERVICE_UNAVAILABLE,
};

/** Campos que el detalle nunca puede pisar en el cuerpo HTTP. */
const CAMPOS_RESERVADOS = new Set(['statusCode', 'message', 'codigo']);

export class FiscalConfigError extends Error {
  override readonly name = 'FiscalConfigError';

  constructor(
    readonly codigo: CodigoFiscal,
    mensaje: string,
    readonly detalle: Readonly<Record<string, unknown>> = {},
  ) {
    super(mensaje);
  }

  get estadoHttp(): number {
    return ESTADO_HTTP[this.codigo] ?? HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /** Cuerpo JSON con el mismo formato que `cuerpoError` más el detalle. */
  cuerpo(): Record<string, unknown> {
    const extra = Object.fromEntries(
      Object.entries(this.detalle).filter(([clave]) => !CAMPOS_RESERVADOS.has(clave)),
    );
    return { ...extra, statusCode: this.estadoHttp, message: this.message, codigo: this.codigo };
  }

  static es(error: unknown, codigo?: CodigoFiscal): error is FiscalConfigError {
    return error instanceof FiscalConfigError && (!codigo || error.codigo === codigo);
  }
}

export function estadoHttpDe(codigo: CodigoFiscal): number {
  return ESTADO_HTTP[codigo] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Traduce un FiscalConfigError a HttpException. Cualquier otro error se
 * devuelve tal cual para que se relance: `catch (e) { throw aHttp(e); }`.
 */
export function aHttp(error: unknown): unknown {
  if (error instanceof FiscalConfigError) {
    return new HttpException(error.cuerpo(), error.estadoHttp, { cause: error });
  }
  return error;
}

/** Atajos para los errores más repetidos. */
export const ErroresFiscales = {
  migracionPendiente(faltantes: readonly string[]): FiscalConfigError {
    return new FiscalConfigError(
      'FISCAL_MIGRACION_PENDIENTE',
      'Falta ejecutar sql/fase9_sunat_directo.sql en la base de datos. Mientras tanto las ventas se registran sin comprobante electrónico.',
      { faltantes: [...faltantes] },
    );
  },
  claveMaestraNoConfigurada(motivo?: string | null): FiscalConfigError {
    return new FiscalConfigError(
      'FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA',
      'Configure FISCAL_SECRET_KEY (32 bytes en base64) en Railway y reinicie el servicio.'
        + (motivo ? ` Detalle: ${motivo}` : ''),
    );
  },
  secretoIlegible(que: string): FiscalConfigError {
    return new FiscalConfigError(
      'FISCAL_SECRETO_ILEGIBLE',
      `No se pudo descifrar ${que}. ¿Cambió FISCAL_SECRET_KEY? Ponga la llave anterior en `
        + 'FISCAL_SECRET_KEY_ANTERIOR o vuelva a cargar el certificado y la clave SOL desde el panel.',
    );
  },
} as const;
