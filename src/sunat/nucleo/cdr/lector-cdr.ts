import type { ObservacionSunat } from '../documento-fiscal.types';
import { hijos, intentarParsearXml, nombreLocal, quitarBom, ruta, texto } from '../xml/lector-xml';

/**
 * Estado de una constancia (CDR) según los rangos oficiales del Manual del
 * Programador §4.1: 0 aceptado; 0100–1999 excepción (no informado);
 * 2000–3999 rechazo; 4000 en adelante observación (aceptado). Los nombres
 * coinciden con los del CdrParserService heredado.
 */
export type EstadoCdr = 'ACEPTADO' | 'ACEPTADO_CON_OBSERVACIONES' | 'RECHAZADO' | 'EXCEPCION' | 'ESTADO_DESCONOCIDO';

export interface CdrLeido {
  /** ResponseCode tal como lo envía SUNAT ('0', '2335', '4252'…); 'ERROR' si no se pudo leer. */
  codigo: string;
  descripcion: string;
  observaciones: ObservacionSunat[];
  estado: EstadoCdr;
  /** Comprobante al que responde (cbc:ReferenceID), si viene. */
  referencia?: string;
  fechaRespuesta?: string;
  horaRespuesta?: string;
}

/** Separa una nota "4252 - El dato ingresado…" en código y descripción. */
export function separarObservacion(nota: string): ObservacionSunat {
  const limpia = String(nota ?? '').replace(/\s+/g, ' ').trim();
  const partes = /^(\d{1,4})\s*[-–:]\s*(.*)$/.exec(limpia);
  return partes ? { codigo: partes[1].padStart(4, '0'), descripcion: partes[2].trim() } : { codigo: '', descripcion: limpia };
}

/** Clasifica un ResponseCode por rango oficial. */
export function estadoPorCodigoCdr(codigo: string, observaciones: readonly ObservacionSunat[] = []): EstadoCdr {
  if (!/^\d{1,4}$/.test(String(codigo ?? '').trim())) return 'ESTADO_DESCONOCIDO';
  const numero = Number(codigo);
  if (numero === 0) return observaciones.length > 0 ? 'ACEPTADO_CON_OBSERVACIONES' : 'ACEPTADO';
  if (numero >= 4000) return 'ACEPTADO_CON_OBSERVACIONES';
  if (numero >= 2000) return 'RECHAZADO';
  if (numero >= 100) return 'EXCEPCION';
  return 'ESTADO_DESCONOCIDO';
}

const CDR_ILEGIBLE: CdrLeido = Object.freeze({
  codigo: 'ERROR',
  descripcion: 'No se pudo interpretar la constancia (CDR) de SUNAT.',
  observaciones: [{ codigo: '', descripcion: 'La respuesta no contiene un ApplicationResponse válido.' }],
  estado: 'ESTADO_DESCONOCIDO',
}) as CdrLeido;

/**
 * Lee un ApplicationResponse de SUNAT sin depender de prefijos, espacios de
 * nombres ni atributos: DocumentResponse/Response/{ResponseCode, Description}
 * y las cbc:Note de la raíz (observaciones "código - texto").
 */
export function leerCdr(xml: string): CdrLeido {
  const documento = typeof xml === 'string' && xml.includes('ApplicationResponse') ? intentarParsearXml(quitarBom(xml)) : null;
  const raiz = documento?.documentElement;
  if (!documento || !raiz || nombreLocal(raiz) !== 'ApplicationResponse') {
    return { ...CDR_ILEGIBLE, observaciones: [...CDR_ILEGIBLE.observaciones] };
  }

  const respuesta = ruta(documento, 'DocumentResponse', 'Response');
  const elementoCodigo = respuesta ? hijos(respuesta, 'ResponseCode')[0] : ruta(documento, 'ResponseCode');
  const elementoDescripcion = respuesta ? hijos(respuesta, 'Description')[0] : hijos(raiz, 'Description')[0];
  const codigo = texto(elementoCodigo) || 'ERROR';
  const observaciones = hijos(raiz, 'Note')
    .map((nota) => texto(nota))
    .filter((nota) => nota !== '')
    .map(separarObservacion);

  return {
    codigo,
    descripcion: texto(elementoDescripcion) || 'Respuesta no reconocida por SUNAT.',
    observaciones,
    estado: estadoPorCodigoCdr(codigo, observaciones),
    referencia: texto(respuesta ? hijos(respuesta, 'ReferenceID')[0] : null) || undefined,
    fechaRespuesta: texto(hijos(raiz, 'ResponseDate')[0]) || undefined,
    horaRespuesta: texto(hijos(raiz, 'ResponseTime')[0]) || undefined,
  };
}
