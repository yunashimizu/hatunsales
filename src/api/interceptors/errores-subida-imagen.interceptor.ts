import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { almacenamientoConfig } from '../../config/almacenamiento.config';

/** Máximo de fotos por petición en la subida en lote (el mismo que usa el controlador). */
export const MAXIMO_FOTOS_POR_LOTE = 10;

/**
 * Nest convierte los MulterError (LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, LIMIT_UNEXPECTED_FILE...)
 * en HttpException con el texto en inglés de multer ANTES de que llegue a cualquier filtro, así
 * que un `@Catch(MulterError)` nunca se activaría. Por eso se reconocen aquí por su mensaje.
 */
const ARCHIVO_MUY_GRANDE = /^file too large/i;
const DEMASIADOS_ARCHIVOS = /^(unexpected field|too many files)/i;

export function traducirErrorSubidaImagen(error: unknown, esLote: boolean): unknown {
  if (error instanceof PayloadTooLargeException || (error instanceof BadRequestException && ARCHIVO_MUY_GRANDE.test(String(error.message)))) {
    const maximoMb = Math.round(almacenamientoConfig.tamanioMaximoBytes / 1024 / 1024);
    return new BadRequestException({
      message: `La foto supera ${maximoMb} MB`,
      codigo: 'FOTO_MUY_GRANDE',
    });
  }
  if (error instanceof BadRequestException && DEMASIADOS_ARCHIVOS.test(String(error.message))) {
    return new BadRequestException({
      message: esLote
        ? `Máximo ${MAXIMO_FOTOS_POR_LOTE} fotos por vez`
        : 'Envíe una sola foto por vez',
      codigo: esLote ? 'DEMASIADAS_FOTOS' : 'FOTO_CAMPO_INVALIDO',
    });
  }
  return error;
}

/**
 * Traduce los errores de subida de multer en las rutas de fotos de producto a 400 en español.
 * Va a nivel de controlador para envolver también al FileInterceptor/FilesInterceptor del método.
 */
@Injectable()
export class ErroresSubidaImagenInterceptor implements NestInterceptor {
  intercept(contexto: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = contexto.switchToHttp().getRequest<{ originalUrl?: string; url?: string }>();
    const esLote = /\/images\/lote(\?|$)/.test(req?.originalUrl ?? req?.url ?? '');
    return next.handle().pipe(catchError((error: unknown) => throwError(() => traducirErrorSubidaImagen(error, esLote))));
  }
}
