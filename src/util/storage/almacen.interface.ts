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

/**
 * Contrato común de los proveedores de almacenamiento. Cambiar de disco a
 * Cloudinary es cambiar una variable de entorno, sin tocar la lógica de
 * negocio.
 */
export interface AlmacenArchivos {
  readonly nombre: string;
  guardar(entrada: ArchivoEntrada): Promise<ArchivoGuardado>;
  eliminar(clave: string): Promise<void>;
}

export const ALMACEN_ARCHIVOS = Symbol('ALMACEN_ARCHIVOS');
