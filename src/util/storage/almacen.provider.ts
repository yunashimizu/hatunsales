import { Logger, Provider } from '@nestjs/common';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { ALMACEN_ARCHIVOS, AlmacenArchivos } from './almacen.interface';
import { CloudinaryAlmacen } from './cloudinary.almacen';
import { BaseDatosAlmacen } from './base-datos.almacen';
import { DiscoAlmacen } from './disco.almacen';

/**
 * Elige el proveedor de almacenamiento según la configuración. Cambiarlo no
 * requiere tocar el código de productos ni de imágenes.
 */
export const almacenProvider: Provider = {
  provide: ALMACEN_ARCHIVOS,
  inject: [CloudinaryAlmacen, BaseDatosAlmacen, DiscoAlmacen],
  useFactory: (
    cloudinary: CloudinaryAlmacen,
    baseDatos: BaseDatosAlmacen,
    disco: DiscoAlmacen,
  ): AlmacenArchivos => {
    const logger = new Logger('AlmacenArchivos');
    const elegido = almacenamientoConfig.proveedor;

    const almacen =
      elegido === 'cloudinary' ? cloudinary : elegido === 'disco' ? disco : baseDatos;

    logger.log(`Las imágenes se guardarán en: ${almacen.nombre}`);
    return almacen;
  },
};
