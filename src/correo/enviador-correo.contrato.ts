/** Adjunto de un correo (el contenido va en memoria; los adaptadores lo pasan a base64). */
export interface AdjuntoCorreo {
  nombre: string;
  mime: string;
  contenido: Buffer;
}

export interface MensajeCorreo {
  para: string;
  asunto: string;
  html: string;
  texto: string;
  adjuntos: AdjuntoCorreo[];
  /** Nombre visible del remitente; si falta se usa CORREO_REMITENTE_NOMBRE o «HATUNSALES». */
  remitenteNombre?: string | null;
}

export interface ResultadoEnvioCorreo {
  id_mensaje: string | null;
}

/**
 * Falla de un envío. `reintentable` es true para red, 429 y 5xx (vale la pena volver a intentar) y false
 * para rechazos del proveedor por datos inválidos (4xx).
 */
export class ErrorEnvioCorreo extends Error {
  constructor(
    mensaje: string,
    readonly reintentable: boolean,
    readonly estadoHttp: number | null = null,
  ) {
    super(mensaje);
    this.name = 'ErrorEnvioCorreo';
  }
}

/** Contrato común de los proveedores de correo (Brevo, Resend o archivo). */
export abstract class EnviadorCorreo {
  abstract readonly nombre: string;
  abstract enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvioCorreo>;
}
