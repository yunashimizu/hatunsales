/**
 * Errores de dominio del núcleo fiscal. Llevan un código estable (para que la
 * API y el panel lo traduzcan) y un mensaje en español listo para mostrar.
 * Nunca incluyen secretos (claves, PEM ni credenciales SOL).
 *
 * Convención para quien los captura (emisión, pruebas, tareas):
 *  - FISCAL_CERT_* y FISCAL_FIRMA_DEMO_NO_PERMITIDA → estado ERROR_CONFIG (revisar el panel).
 *  - FISCAL_DOCUMENTO_INVALIDO → estado EXCEPCION (corregir los datos; no se envió nada).
 *  - El resto indica un defecto del programa o de los datos de entrada.
 */

export type CodigoErrorNucleo =
  | 'FISCAL_DOCUMENTO_INVALIDO'
  | 'FISCAL_TIPO_NO_SOPORTADO'
  | 'FISCAL_MONTO_INVALIDO'
  | 'FISCAL_XML_INVALIDO'
  | 'FISCAL_FIRMA_FALLIDA'
  | 'FISCAL_FIRMA_DEMO_NO_PERMITIDA'
  | 'FISCAL_CERT_CLAVE_INCORRECTA'
  | 'FISCAL_CERT_FORMATO_INVALIDO'
  | 'FISCAL_CERT_FORMATO_NO_SOPORTADO'
  | 'FISCAL_CERT_SIN_CLAVE_PRIVADA'
  | 'FISCAL_CERT_NO_CORRESPONDE'
  | 'FISCAL_CERT_VENCIDO'
  | 'FISCAL_CERT_NO_VIGENTE'
  | 'FISCAL_ZIP_INVALIDO'
  | 'FISCAL_QR_INVALIDO'
  | 'FISCAL_RESUMEN_INVALIDO'
  | 'FISCAL_BAJA_INVALIDA'
  | 'FISCAL_SOAP_CONFIG_INVALIDA';

export class ErrorNucleoFiscal extends Error {
  readonly codigo: CodigoErrorNucleo;
  readonly detalle?: Readonly<Record<string, unknown>>;

  constructor(codigo: CodigoErrorNucleo, mensaje: string, detalle?: Record<string, unknown>) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

/** El documento no pasa las validaciones previas al envío (no debe firmarse ni enviarse). */
export class DocumentoCpeInvalidoError extends ErrorNucleoFiscal {
  readonly errores: readonly string[];
  readonly advertencias: readonly string[];

  constructor(errores: readonly string[], mensaje?: string, advertencias: readonly string[] = []) {
    super(
      'FISCAL_DOCUMENTO_INVALIDO',
      mensaje ?? `El comprobante no pasa las validaciones previas al envío: ${errores.join(' | ')}`,
      { errores: [...errores], advertencias: [...advertencias] },
    );
    this.errores = errores;
    this.advertencias = advertencias;
  }
}

export class XmlInvalidoError extends ErrorNucleoFiscal {
  constructor(mensaje: string) {
    super('FISCAL_XML_INVALIDO', mensaje);
  }
}

export class FirmaXmlError extends ErrorNucleoFiscal {
  constructor(mensaje: string, detalle?: Record<string, unknown>) {
    super('FISCAL_FIRMA_FALLIDA', mensaje, detalle);
  }
}

export class FirmaDemoNoPermitidaError extends ErrorNucleoFiscal {
  constructor(mensaje: string) {
    super('FISCAL_FIRMA_DEMO_NO_PERMITIDA', mensaje);
  }
}

export type CodigoErrorCertificado = Extract<
  CodigoErrorNucleo,
  | 'FISCAL_CERT_CLAVE_INCORRECTA'
  | 'FISCAL_CERT_FORMATO_INVALIDO'
  | 'FISCAL_CERT_FORMATO_NO_SOPORTADO'
  | 'FISCAL_CERT_SIN_CLAVE_PRIVADA'
  | 'FISCAL_CERT_NO_CORRESPONDE'
  | 'FISCAL_CERT_VENCIDO'
  | 'FISCAL_CERT_NO_VIGENTE'
>;

export class CertificadoDigitalError extends ErrorNucleoFiscal {
  constructor(codigo: CodigoErrorCertificado, mensaje: string) {
    super(codigo, mensaje);
  }
}

export class PaqueteZipError extends ErrorNucleoFiscal {
  constructor(mensaje: string) {
    super('FISCAL_ZIP_INVALIDO', mensaje);
  }
}

export class CadenaQrError extends ErrorNucleoFiscal {
  constructor(mensaje: string) {
    super('FISCAL_QR_INVALIDO', mensaje);
  }
}

export class ResumenInvalidoError extends ErrorNucleoFiscal {
  readonly errores: readonly string[];

  constructor(mensaje: string, errores: readonly string[] = [mensaje]) {
    super('FISCAL_RESUMEN_INVALIDO', mensaje, { errores: [...errores] });
    this.errores = errores;
  }
}

export class BajaInvalidaError extends ErrorNucleoFiscal {
  readonly errores: readonly string[];

  constructor(mensaje: string, errores: readonly string[] = [mensaje]) {
    super('FISCAL_BAJA_INVALIDA', mensaje, { errores: [...errores] });
    this.errores = errores;
  }
}

export class ConfiguracionSoapInvalidaError extends ErrorNucleoFiscal {
  constructor(mensaje: string) {
    super('FISCAL_SOAP_CONFIG_INVALIDA', mensaje);
  }
}

export function esErrorNucleoFiscal(error: unknown): error is ErrorNucleoFiscal {
  return error instanceof ErrorNucleoFiscal;
}

/** true si el error se resuelve en el panel (certificado o firma), no corrigiendo el documento. */
export function esErrorDeConfiguracion(error: unknown): boolean {
  return esErrorNucleoFiscal(error) && (error.codigo.startsWith('FISCAL_CERT_') || error.codigo === 'FISCAL_FIRMA_DEMO_NO_PERMITIDA');
}
