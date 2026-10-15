import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface OpcionesCabecerasSeguridad {
  /** Strict-Transport-Security: solo en producción (HTTPS detrás del edge de Railway). */
  readonly hsts: boolean;
}

/** 180 días. Sin includeSubDomains ni preload: no afecta otros dominios del dueño. */
export const VALOR_HSTS = 'max-age=15552000';

/**
 * Cabeceras de seguridad básicas para una API JSON. No se usa helmet: sus
 * valores por defecto (Cross-Origin-Resource-Policy same-origin y CSP estricta)
 * bloquearían las imágenes de /archivos y /uploads que carga el front desde
 * Vercel y el visor de PDF del navegador. Tampoco se envía X-Frame-Options para
 * no romper vistas previas de PDF.
 */
export function crearMiddlewareCabecerasSeguridad(opciones: OpcionesCabecerasSeguridad): RequestHandler {
  return function cabecerasSeguridad(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (opciones.hsts) res.setHeader('Strict-Transport-Security', VALOR_HSTS);
    next();
  };
}
