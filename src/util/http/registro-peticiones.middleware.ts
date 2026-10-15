import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CABECERA_ID_PETICION, ContextoPeticion } from './contexto-peticion';
import { rutaSegura } from './enmascarar';

/** Marca que deja el filtro global cuando ya registró un 5xx (evita líneas duplicadas). */
export const MARCA_ERROR_REGISTRADO = 'errorRegistrado';

export interface OpcionesRegistroPeticiones {
  /** Desde cuántos ms una petición se considera lenta. */
  readonly umbralLentoMs: number;
  readonly registrador?: Pick<Logger, 'warn' | 'error'>;
}

/** Ruta para el log: la plantilla de Nest (`/venta/:id`) o, si no hubo ruta, la URL enmascarada. */
export function rutaParaLog(req: Request): string {
  const plantilla = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof plantilla === 'string' && plantilla) return `${req.baseUrl ?? ''}${plantilla}`;
  return rutaSegura(req.originalUrl ?? req.url);
}

/**
 * Asigna el id de petición (cabecera X-Request-Id de entrada o uno nuevo), lo
 * devuelve en la respuesta y lo deja en el contexto asíncrono. Al terminar
 * registra las peticiones lentas y los 5xx que no pasaron por el filtro global.
 * Nunca escribe query strings, cuerpos ni IPs.
 */
export function crearMiddlewareRegistroPeticiones(opciones: OpcionesRegistroPeticiones): RequestHandler {
  const registrador = opciones.registrador ?? new Logger('HTTP');

  return function registroPeticiones(req: Request, res: Response, next: NextFunction): void {
    const idPeticion = ContextoPeticion.resolverId(req.headers);
    res.locals.idPeticion = idPeticion;
    res.setHeader(CABECERA_ID_PETICION, idPeticion);

    const inicio = process.hrtime.bigint();
    let registrada = false;

    const alCerrar = (): void => {
      if (registrada) return;
      registrada = true;
      const ms = Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);
      const completa = res.writableFinished;
      const errorSinRegistrar = completa && res.statusCode >= 500 && res.locals[MARCA_ERROR_REGISTRADO] !== true;
      const lenta = ms >= opciones.umbralLentoMs;
      if (!errorSinRegistrar && !lenta) return;

      const resultado = completa ? String(res.statusCode) : 'cancelada por el cliente';
      const linea = `${req.method} ${rutaParaLog(req)} → ${resultado} · ${ms} ms [${idPeticion}]`;
      if (errorSinRegistrar) registrador.error(`Respuesta con error: ${linea}`);
      else registrador.warn(`Petición lenta: ${linea}`);
    };

    res.once('finish', alCerrar);
    res.once('close', alCerrar);
    ContextoPeticion.ejecutar({ idPeticion }, () => next());
  };
}
