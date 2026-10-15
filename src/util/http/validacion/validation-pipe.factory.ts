import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { cuerpoErrorValidacion } from './mensajes-validacion';

/**
 * ValidationPipe global:
 *  - whitelist + transform, igual que antes (lo no declarado en el DTO se descarta).
 *  - SIN forbidNonWhitelisted: el panel y la tienda envían campos extra y no deben recibir 400.
 *  - stopAtFirstError: un solo mensaje por campo.
 *  - Mensajes en español y `codigo: 'VALIDACION'`; `message` sigue siendo un arreglo.
 */
export function crearValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errores) => new BadRequestException(cuerpoErrorValidacion(errores)),
  });
}
