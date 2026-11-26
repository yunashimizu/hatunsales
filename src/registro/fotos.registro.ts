import { FotosMejoraController } from '../api/controllers/fotos-mejora.controller';
import { ProductoImagenMejoraController } from '../api/controllers/producto-imagen-mejora.controller';
import { AlmacenesPorNombre } from '../fotos/almacenes-por-nombre';
import { EsquemaMejoraFotos } from '../fotos/esquema-mejora-fotos';
import { MejoraFotosRepository } from '../fotos/mejora-fotos.repository';
import { MejoraFotosService } from '../fotos/mejora-fotos.service';
import { ReprocesadoFotosRepository } from '../fotos/reprocesado-fotos.repository';
import { ReprocesadoFotosService } from '../fotos/reprocesado-fotos.service';
import { RegistroModulo } from './registro-modulo';

/**
 * Mejora automática de fotos de producto (src/fotos, sql/fase23_mejora_fotos.sql). Usa además
 * ProductoImagenRepository, ConfiguracionRepository, los tres almacenes y ALMACEN_ARCHIVOS (app.module.ts).
 * ProductoImagenBussnies recibe MejoraFotosService como parámetro opcional y BaseDatosAlmacen recibe
 * EsquemaMejoraFotos para respetar la tabla al borrar archivos.
 */
export const REGISTRO_FOTOS: RegistroModulo = {
  entidades: [],
  controladores: [ProductoImagenMejoraController, FotosMejoraController],
  proveedores: [
    EsquemaMejoraFotos, MejoraFotosRepository, AlmacenesPorNombre, MejoraFotosService,
    ReprocesadoFotosRepository, ReprocesadoFotosService,
  ],
};
