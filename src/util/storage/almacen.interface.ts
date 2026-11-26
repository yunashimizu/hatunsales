export interface ArchivoEntrada {
  buffer: Buffer;
  nombre_original: string;
  mime: string;
  /** Agrupador lógico, por ejemplo `productos/12`. */
  carpeta: string;
}

export interface ArchivoGuardado {
  /** URL con la que el navegador pide la imagen a tamaño completo. */
  url: string;
  /** Versión reducida para listados y miniaturas. */
  thumb_url: string;
  /** Identificador con el que el proveedor puede borrarla después. */
  clave: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  proveedor: string;
}

/** Los bytes de un archivo ya guardado. */
export interface ArchivoLeido {
  buffer: Buffer;
  mime: string;
}

/** Lo más pesado que se lee de vuelta para revisar o mejorar una foto (las subidas admiten 5 MB). */
export const BYTES_MAXIMOS_LECTURA = 12 * 1024 * 1024;

/**
 * Contrato común de los proveedores de almacenamiento. Cambiar de disco a
 * Cloudinary es cambiar una variable de entorno, sin tocar la lógica de
 * negocio.
 */
export interface AlmacenArchivos {
  readonly nombre: string;
  guardar(entrada: ArchivoEntrada): Promise<ArchivoGuardado>;
  eliminar(clave: string): Promise<void>;
  /**
   * El archivo tal como se subió (sin transformaciones), para revisar o mejorar fotos antiguas.
   * `null` si ese archivo ya no está o este almacén no puede leerlo; lanza si es un fallo pasajero.
   */
  leerOriginal?(guardado: { clave: string; url: string }): Promise<ArchivoLeido | null>;
}

export const ALMACEN_ARCHIVOS = Symbol('ALMACEN_ARCHIVOS');
