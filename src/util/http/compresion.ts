import compression from 'compression';
import type { Request, RequestHandler, Response } from 'express';

/** Por debajo de 1 KB comprimir cuesta más (CPU y cabeceras gzip) de lo que ahorra. */
export const UMBRAL_COMPRESION_BYTES = 1024;

/**
 * Tipos que no se comprimen: ya vienen comprimidos (zip, xlsx, pdf, imágenes) o son
 * binarios opacos. Pasarlos por gzip gasta CPU sin ahorrar bytes.
 */
const TIPOS_SIN_COMPRESION: readonly RegExp[] = [
  /^image\//i,
  /^application\/zip\b/i,
  /^application\/pdf\b/i,
  /^application\/octet-stream\b/i,
  /^application\/vnd\.openxmlformats/i,
];

/**
 * Filtro de `compression`, que lo evalúa cuando la respuesta ya tiene sus cabeceras.
 * Las descargas (Content-Disposition: attachment: XML y CDR fiscales, reportes) salen
 * tal cual, byte a byte y con su Content-Length. El resto sigue el filtro estándar
 * (solo tipos comprimibles); `Cache-Control: no-transform` lo respeta el propio middleware.
 */
export function debeComprimir(req: Request, res: Response): boolean {
  if (/^\s*attachment\b/i.test(textoCabecera(res.getHeader('Content-Disposition')))) return false;
  const tipo = textoCabecera(res.getHeader('Content-Type'));
  if (TIPOS_SIN_COMPRESION.some((patron) => patron.test(tipo))) return false;
  return compression.filter(req, res);
}

/** Compresión de las respuestas JSON y de texto (auditoría R01). */
export function crearMiddlewareCompresion(): RequestHandler {
  return compression({ threshold: UMBRAL_COMPRESION_BYTES, filter: debeComprimir });
}

function textoCabecera(valor: number | string | string[] | undefined): string {
  if (valor === undefined) return '';
  return Array.isArray(valor) ? valor.join(', ') : String(valor);
}
