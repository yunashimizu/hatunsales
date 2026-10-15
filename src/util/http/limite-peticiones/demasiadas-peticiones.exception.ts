import { HttpException, HttpStatus } from '@nestjs/common';

/** Mismo código que ya usa el front para sus avisos globales de 429. */
export const CODIGO_DEMASIADAS_SOLICITUDES = 'DEMASIADAS_SOLICITUDES';

/**
 * 429 con `reintentarEnSeg` en el cuerpo; el filtro global envía además la
 * cabecera Retry-After con el mismo valor.
 */
export class DemasiadasPeticionesException extends HttpException {
  constructor(
    readonly reintentarEnSeg: number,
    mensaje: string,
  ) {
    const segundos = Math.max(1, Math.ceil(reintentarEnSeg));
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: mensaje,
        codigo: CODIGO_DEMASIADAS_SOLICITUDES,
        reintentarEnSeg: segundos,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
