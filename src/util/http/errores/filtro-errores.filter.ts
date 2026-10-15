import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CABECERA_ID_PETICION, ContextoPeticion } from '../contexto-peticion';
import { enmascararDatosPersonales, recortar, rutaSegura } from '../enmascarar';
import { MARCA_ERROR_REGISTRADO } from '../registro-peticiones.middleware';
import { sinCamposReservados } from './error-dominio';
import type { ErrorTraducido, TraductorError } from './error-traducido';
import { fraseEstado, mensajePorEstado } from './estado-http';
import { TraductorErrorDominio } from './traductor-error-dominio';
import { TraductorErroresBaseDatos } from './traductor-errores-bd';
import { TraductorErroresExternos } from './traductor-errores-externos';
import { TraductorHttpException } from './traductor-http-exception';

/** Cuerpo uniforme de todos los errores del API. */
export interface CuerpoErrorApi {
  readonly statusCode: number;
  /** Texto en español; arreglo solo en errores de validación (como siempre). */
  readonly message: string | string[];
  readonly error: string;
  readonly codigo: string;
  /** Ruta pedida, sin query string y con datos personales enmascarados. */
  readonly ruta: string;
  /** Igual a la cabecera X-Request-Id: el "código de soporte". */
  readonly idPeticion: string;
  readonly reintentarEnSeg?: number;
  readonly [campo: string]: unknown;
}

/** Orden de evaluación: el primero que reconoce el error lo traduce. */
export function traductoresPorDefecto(): TraductorError[] {
  return [
    new TraductorHttpException(),
    new TraductorErrorDominio(),
    new TraductorErroresBaseDatos(),
    new TraductorErroresExternos(),
  ];
}

const LARGO_MAXIMO_LOG = 2000;

function errorDesconocido(excepcion: unknown): ErrorTraducido {
  const descripcion =
    excepcion instanceof Error ? `${excepcion.name}: ${excepcion.message}` : `Valor lanzado: ${String(excepcion)}`;
  return { estado: 500, codigo: 'ERROR_SERVIDOR', mensaje: mensajePorEstado(500), registro: 'error', detalleLog: descripcion };
}

export function construirCuerpoError(traducido: ErrorTraducido, ruta: string, idPeticion: string): CuerpoErrorApi {
  return {
    statusCode: traducido.estado,
    message: traducido.mensaje,
    error: traducido.error ?? fraseEstado(traducido.estado),
    codigo: traducido.codigo,
    ...(traducido.reintentarEnSeg ? { reintentarEnSeg: traducido.reintentarEnSeg } : {}),
    ...sinCamposReservados(traducido.extra),
    ruta,
    idPeticion,
  };
}

/**
 * Filtro global de errores: toda excepción sale con el mismo formato
 * `{statusCode, message, error, codigo, ruta, idPeticion}` (más los campos de
 * dominio que traiga). Las HttpException conservan estado, mensaje y código;
 * los errores de PostgreSQL, de red y de body-parser se traducen a 4xx/5xx con
 * mensajes en español. Los 5xx se registran con el id de petición y sin datos
 * personales (sin parámetros SQL, cuerpos ni query strings).
 */
@Catch()
export class FiltroErroresGlobal implements ExceptionFilter {
  private readonly logger = new Logger('Errores');

  constructor(private readonly traductores: readonly TraductorError[] = traductoresPorDefecto()) {}

  catch(excepcion: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.error(`Error fuera de HTTP (${host.getType()}): ${this.descripcion(excepcion)}`);
      return;
    }
    const contexto = host.switchToHttp();
    const req = contexto.getRequest<Request>();
    const res = contexto.getResponse<Response>();

    const traducido = this.traducir(excepcion);
    const ruta = rutaSegura(req?.originalUrl ?? req?.url);
    const idPeticion = this.idPeticion(req, res);
    this.registrar(traducido, excepcion, req, res, ruta, idPeticion);

    if (res.headersSent) {
      // La respuesta ya empezó (p. ej. un PDF a medio enviar): cortarla evita entregar un archivo truncado como bueno.
      if (!res.writableEnded) res.destroy();
      return;
    }

    res.removeHeader('Content-Disposition');
    res.setHeader('Cache-Control', 'no-store');
    if (!res.getHeader(CABECERA_ID_PETICION)) res.setHeader(CABECERA_ID_PETICION, idPeticion);
    if (traducido.reintentarEnSeg) res.setHeader('Retry-After', String(traducido.reintentarEnSeg));
    res.status(traducido.estado).json(construirCuerpoError(traducido, ruta, idPeticion));
  }

  /** Traducción sin efectos (útil también fuera del filtro). */
  traducir(excepcion: unknown): ErrorTraducido {
    for (const traductor of this.traductores) {
      try {
        const resultado = traductor.traducir(excepcion);
        if (resultado) return resultado;
      } catch (fallo) {
        this.logger.error(`Falló el traductor ${traductor.constructor.name}: ${this.descripcion(fallo)}`);
      }
    }
    return errorDesconocido(excepcion);
  }

  private idPeticion(req: Request | undefined, res: Response): string {
    const enLocals = res.locals?.idPeticion;
    if (typeof enLocals === 'string' && enLocals) return enLocals;
    return ContextoPeticion.idActual() ?? ContextoPeticion.resolverId(req?.headers);
  }

  private registrar(
    traducido: ErrorTraducido,
    excepcion: unknown,
    req: Request | undefined,
    res: Response,
    ruta: string,
    idPeticion: string,
  ): void {
    if (traducido.registro === 'ninguno') return;
    const linea = recortar(
      enmascararDatosPersonales(
        `${req?.method ?? '?'} ${ruta} → ${traducido.estado} ${traducido.codigo} [${idPeticion}]`
          + (traducido.detalleLog ? ` · ${traducido.detalleLog}` : ''),
      ),
      LARGO_MAXIMO_LOG,
    );
    if (traducido.estado >= 500 && res.locals) res.locals[MARCA_ERROR_REGISTRADO] = true;

    if (traducido.registro === 'advertencia') {
      this.logger.warn(linea);
      return;
    }
    const pila = excepcion instanceof Error && excepcion.stack ? enmascararDatosPersonales(excepcion.stack) : undefined;
    this.logger.error(linea, pila);
  }

  private descripcion(valor: unknown): string {
    const texto = valor instanceof Error ? `${valor.name}: ${valor.message}` : String(valor);
    return recortar(enmascararDatosPersonales(texto), LARGO_MAXIMO_LOG);
  }
}
