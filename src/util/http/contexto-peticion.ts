import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Cabecera con la que el cliente puede enviar su id y con la que se devuelve. */
export const CABECERA_ID_PETICION = 'X-Request-Id';

/** Railway la agrega en su edge: sirve para cruzar con sus logs HTTP. */
const CABECERA_RAILWAY = 'x-railway-request-id';

/** Solo se aceptan ids razonables (evita inyección en logs y valores enormes). */
const ID_ACEPTABLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface DatosPeticion {
  readonly idPeticion: string;
}

type Cabeceras = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Contexto por petición (AsyncLocalStorage): permite que capas sin acceso a la
 * request, como el logger de TypeORM, escriban el id de la petición en sus logs.
 */
export class ContextoPeticion {
  private static readonly almacen = new AsyncLocalStorage<DatosPeticion>();

  static ejecutar<T>(datos: DatosPeticion, fn: () => T): T {
    return this.almacen.run(datos, fn);
  }

  static idActual(): string | undefined {
    return this.almacen.getStore()?.idPeticion;
  }

  /** Usa X-Request-Id (o el id del edge de Railway) si es válido; si no, genera un UUID. */
  static resolverId(cabeceras: Cabeceras | undefined): string {
    for (const nombre of [CABECERA_ID_PETICION.toLowerCase(), CABECERA_RAILWAY]) {
      const valor = cabeceras?.[nombre];
      const texto = (Array.isArray(valor) ? valor[0] : valor)?.trim();
      if (texto && ID_ACEPTABLE.test(texto)) return texto;
    }
    return randomUUID();
  }
}
