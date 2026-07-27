/**
 * Dónde se guardan las imágenes de los productos.
 *
 * El disco local no sirve en producción: Railway reconstruye el contenedor en
 * cada despliegue y todo lo escrito en él se pierde. Por eso el proveedor por
 * defecto es la base de datos, y cuando hay credenciales de Cloudinary se usa
 * ese, que además entrega las imágenes por CDN.
 */
export type ProveedorAlmacen = 'cloudinary' | 'base_datos' | 'disco';

const cloudinary = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? '',
  api_key: process.env.CLOUDINARY_API_KEY ?? '',
  api_secret: process.env.CLOUDINARY_API_SECRET ?? '',
  carpeta: process.env.CLOUDINARY_CARPETA ?? 'hatunsales/productos',
};

function proveedorActivo(): ProveedorAlmacen {
  const elegido = (process.env.STORAGE_PROVIDER ?? '').toLowerCase();

  if (elegido === 'cloudinary' || elegido === 'base_datos' || elegido === 'disco') {
    return elegido;
  }

  const tieneCloudinary = Boolean(cloudinary.cloud_name && cloudinary.api_key && cloudinary.api_secret);
  return tieneCloudinary ? 'cloudinary' : 'base_datos';
}

export const almacenamientoConfig = {
  proveedor: proveedorActivo(),
  cloudinary,
  disco: {
    ruta: process.env.PRODUCT_IMAGES_PATH ?? 'uploads/products',
    urlPublica: process.env.PRODUCT_IMAGES_URL ?? '/uploads',
  },
  /** Peso máximo por imagen. */
  tamanioMaximoBytes: Number(process.env.IMAGEN_TAMANIO_MAXIMO ?? 5 * 1024 * 1024),
  tiposPermitidos: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'],
};
