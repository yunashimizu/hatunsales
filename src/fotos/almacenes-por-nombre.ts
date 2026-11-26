import { Inject, Injectable } from '@nestjs/common';
import { ALMACEN_ARCHIVOS } from '../util/storage/almacen.interface';
import type { AlmacenArchivos, ArchivoLeido } from '../util/storage/almacen.interface';
import { BaseDatosAlmacen } from '../util/storage/base-datos.almacen';
import { CloudinaryAlmacen } from '../util/storage/cloudinary.almacen';
import { DiscoAlmacen } from '../util/storage/disco.almacen';

/**
 * Resuelve el almacén por el `proveedor` guardado en cada fila. Una foto puede haberse subido con otro
 * almacén que el de hoy (se cambió la variable de entorno): su original hay que borrarla, o leerla, en
 * el almacén donde está, no en el actual.
 */
@Injectable()
export class AlmacenesPorNombre {
  constructor(
    @Inject(ALMACEN_ARCHIVOS) private readonly actual: AlmacenArchivos,
    private readonly baseDatos: BaseDatosAlmacen,
    private readonly cloudinary: CloudinaryAlmacen,
    private readonly disco: DiscoAlmacen,
  ) {}

  /** El almacén de ese nombre; si el nombre falta o no se conoce, el actual. */
  resolver(proveedor: string | null | undefined): AlmacenArchivos {
    const todos: AlmacenArchivos[] = [this.actual, this.baseDatos, this.cloudinary, this.disco];
    return todos.find((a) => a.nombre === proveedor) ?? this.actual;
  }

  /**
   * Lee los bytes de un archivo guardado (para revisar o mejorar una foto ya subida). Lo que se sirve
   * por `/archivos/N` está en la base, diga lo que diga el proveedor; lo demás se pide al almacén de
   * ese nombre, sin caer en el actual si no se conoce. `null`: no se puede leer.
   */
  async leer(proveedor: string | null | undefined, clave: string, url = ''): Promise<ArchivoLeido | null> {
    const interno = /^\/archivos\/(\d+)$/.exec(url);
    if (interno) return this.baseDatos.leerOriginal({ clave: interno[1], url });
    const almacen = [this.actual, this.baseDatos, this.cloudinary, this.disco].find((a) => a.nombre === proveedor);
    return (await almacen?.leerOriginal?.({ clave, url })) ?? null;
  }
}
