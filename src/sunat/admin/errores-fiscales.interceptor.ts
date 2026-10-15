import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { aHttp, FiscalConfigError } from '../config/fiscal-errores';

/** Errores de multer que Nest convierte en 400 genérico (en inglés). */
const ERRORES_MULTER = /unexpected field|too many (files|fields|parts)|field (name|value) too long|multipart/i;

/**
 * Traduce los errores de dominio fiscales (FiscalConfigError) al cuerpo HTTP
 * estándar `{ statusCode, message, codigo, ...detalle }` y los errores de
 * subida de multer a códigos FISCAL_* en español. Va a nivel de controlador,
 * así envuelve también al FileInterceptor del método.
 */
export function traducirErrorFiscal(error: unknown): unknown {
  if (error instanceof FiscalConfigError) return aHttp(error);
  if (error instanceof PayloadTooLargeException) {
    return aHttp(
      new FiscalConfigError(
        'FISCAL_CERT_DEMASIADO_GRANDE',
        'El archivo supera 200 KB: un certificado .pfx pesa normalmente menos de 10 KB. Revise que sea el archivo correcto.',
      ),
    );
  }
  if (error instanceof BadRequestException && ERRORES_MULTER.test(String(error.message))) {
    return aHttp(
      new FiscalConfigError(
        'FISCAL_CERT_FORMATO_INVALIDO',
        'Envíe un solo archivo en el campo «archivo» y la contraseña en el campo «clave» (multipart/form-data).',
      ),
    );
  }
  return error;
}

@Injectable()
export class ErroresFiscalesInterceptor implements NestInterceptor {
  intercept(_contexto: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => traducirErrorFiscal(error))));
  }
}
