import type { ArchivoFoto, EstadoMejora, FilaMejora, FotoConMejora } from './mejora-fotos.repository';

/**
 * Doble en memoria de MejoraFotosRepository + productos_imagenes, con las mismas reglas que el SQL real
 * (publicar y registrar solo si la imagen sigue apuntando a la original; elegir sin borrar nada). Lo
 * usan los specs del servicio y de ProductoImagenBussnies. Solo para pruebas.
 */
export interface ImagenEnMemoria {
  id_imagen: number;
  id_producto: number;
  url: string;
  thumb_url: string | null;
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  clave_almacen: string | null;
  proveedor: string | null;
  is_primary?: boolean;
  orden?: number;
}

export class RepoMejoraEnMemoria {
  tabla = true;
  readonly filas = new Map<number, FilaMejora>();
  readonly imagenes = new Map<number, ImagenEnMemoria>();
  /** Para simular fallos: el próximo `publicarMejorada` lanza este error. */
  fallarPublicar: Error | null = null;

  disponible = jest.fn(async () => this.tabla);

  porImagen = jest.fn(async (id: number) => this.filas.get(id) ?? null);

  porProducto = jest.fn(async (id_producto: number): Promise<FotoConMejora[]> =>
    [...this.imagenes.values()]
      .filter((i) => i.id_producto === id_producto)
      .map((i) => ({ id_imagen: i.id_imagen, url: i.url, width: i.width, height: i.height, mejora: this.filas.get(i.id_imagen) ?? null })));

  publicarMejorada = jest.fn(async (id: number, version: number, original: ArchivoFoto, mejorada: ArchivoFoto, informe: unknown, soloSiNueva = false) => {
    if (this.fallarPublicar) {
      const error = this.fallarPublicar;
      this.fallarPublicar = null;
      throw error;
    }
    const imagen = this.imagenes.get(id);
    if (!imagen || imagen.url !== original.url || (soloSiNueva && this.filas.has(id))) return false;
    this.filas.set(id, this.fila(id, 'mejorada', version, original, mejorada, informe));
    Object.assign(imagen, {
      url: mejorada.url, thumb_url: mejorada.thumb_url, mime: mejorada.mime, size: mejorada.size,
      width: mejorada.ancho, height: mejorada.alto, clave_almacen: mejorada.clave, proveedor: mejorada.proveedor,
    });
    return true;
  });

  registrar = jest.fn(async (id: number, estado: Exclude<EstadoMejora, 'mejorada'>, version: number, original: ArchivoFoto, informe: unknown, soloSiNueva = false) => {
    const imagen = this.imagenes.get(id);
    if (!imagen || imagen.url !== original.url || (soloSiNueva && this.filas.has(id))) return false;
    this.filas.set(id, this.fila(id, estado, version, original, null, informe));
    return true;
  });

  elegir = jest.fn(async (id: number, cual: 'original' | 'mejorada') => {
    const f = this.filas.get(id);
    const imagen = this.imagenes.get(id);
    if (!f || !imagen || (cual === 'mejorada' && !f.url_mejorada)) return false;
    f.estado = cual === 'mejorada' ? 'mejorada' : 'original_elegido';
    const m = cual === 'mejorada';
    Object.assign(imagen, {
      url: m ? f.url_mejorada : f.url_original,
      thumb_url: m ? (f.thumb_mejorada ?? f.url_mejorada) : (f.thumb_original ?? f.url_original),
      mime: m ? f.mime_mejorada : f.mime_original,
      size: m ? f.size_mejorada : f.size_original,
      width: m ? f.ancho_mejorada : f.ancho_original,
      height: m ? f.alto_mejorada : f.alto_original,
      clave_almacen: m ? f.clave_mejorada : f.clave_original,
      proveedor: m ? f.proveedor_mejorada : f.proveedor_original,
    });
    return true;
  });

  eliminarFila = jest.fn(async (id: number) => {
    this.filas.delete(id);
  });

  private fila(id: number, estado: EstadoMejora, version: number, o: ArchivoFoto, m: ArchivoFoto | null, informe: unknown): FilaMejora {
    return {
      id_imagen: id, estado, version,
      proveedor_original: o.proveedor, url_original: o.url, clave_original: o.clave, thumb_original: o.thumb_url,
      mime_original: o.mime, size_original: o.size, ancho_original: o.ancho, alto_original: o.alto,
      proveedor_mejorada: m?.proveedor ?? null, url_mejorada: m?.url ?? null, clave_mejorada: m?.clave ?? null,
      thumb_mejorada: m?.thumb_url ?? null, mime_mejorada: m?.mime ?? null, size_mejorada: m?.size ?? null,
      ancho_mejorada: m?.ancho ?? null, alto_mejorada: m?.alto ?? null,
      informe: (informe ?? {}) as Record<string, unknown>,
    };
  }
}

/** Almacén «base_datos» falso: numera los archivos y reutiliza el número si el contenido se repite. */
export class AlmacenEnMemoria {
  readonly nombre = 'base_datos';
  private siguiente = 100;
  readonly porHuella = new Map<string, number>();
  readonly contenidos = new Map<number, { buffer: Buffer; mime: string }>();
  fallarGuardar: ((entrada: { nombre_original: string }) => Error | null) | null = null;

  guardar = jest.fn(async (entrada: { buffer: Buffer; nombre_original: string; mime: string; carpeta: string }) => {
    const error = this.fallarGuardar?.(entrada);
    if (error) throw error;
    const huella = entrada.buffer.toString('base64');
    let id = this.porHuella.get(huella);
    if (!id) {
      id = this.siguiente++;
      this.porHuella.set(huella, id);
      this.contenidos.set(id, { buffer: entrada.buffer, mime: entrada.mime });
    }
    return { url: `/archivos/${id}`, thumb_url: `/archivos/${id}`, clave: String(id), mime: entrada.mime, size: entrada.buffer.length, width: 10, height: 10, proveedor: 'base_datos' };
  });

  eliminar = jest.fn(async (_clave: string) => undefined);

  leer = jest.fn(async (id: number) => {
    const c = this.contenidos.get(id);
    return c ? { contenido: c.buffer, mime: c.mime, hash: String(id) } : null;
  });

  leerOriginal = jest.fn(async (guardado: { clave: string; url: string }) => {
    const c = this.contenidos.get(Number(guardado.clave));
    return c ? { buffer: c.buffer, mime: c.mime } : null;
  });
}
