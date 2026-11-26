import { unirRegistros } from './registro-modulo';
import { REGISTRO_PLATAFORMA } from './plataforma.registro';
import { REGISTRO_CAJA } from '../caja/registro/caja.registro';
import { REGISTRO_SUNAT_CONFIG } from '../sunat/registro/config.registro';
import { REGISTRO_SUNAT_NUCLEO } from '../sunat/registro/nucleo.registro';
import { REGISTRO_SUNAT_EMISION } from '../sunat/registro/emision.registro';
import { REGISTRO_SUNAT_DOCUMENTOS } from '../sunat/registro/documentos.registro';
import { REGISTRO_SUNAT_GRE } from '../sunat/registro/gre.registro';
import { REGISTRO_NOTAS_CREDITO } from './notas-credito.registro';
import { REGISTRO_VENTA_DOCUMENTOS } from './venta-documentos.registro';
import { REGISTRO_GUIAS } from './guias.registro';
import { REGISTRO_CORREO } from './correo.registro';
import { REGISTRO_BITACORA } from './bitacora.registro';
import { REGISTRO_CONTROL_REBAJA } from './control-rebaja.registro';
import { REGISTRO_CAJA_DEVOLUCIONES } from './caja-devoluciones.registro';
import { REGISTRO_STOCK_PEDIDOS } from './stock-pedidos.registro';
import { REGISTRO_DATOS_LIMPIOS } from './datos-limpios.registro';
import { REGISTRO_FOTOS } from './fotos.registro';

/** Todo lo que los dominios registran en AppModule (ver registro-modulo.ts). */
export const REGISTROS = unirRegistros(
  REGISTRO_PLATAFORMA,
  REGISTRO_CAJA,
  REGISTRO_SUNAT_CONFIG,
  REGISTRO_SUNAT_NUCLEO,
  REGISTRO_SUNAT_EMISION,
  REGISTRO_SUNAT_DOCUMENTOS,
  REGISTRO_SUNAT_GRE,
  REGISTRO_NOTAS_CREDITO,
  REGISTRO_VENTA_DOCUMENTOS,
  REGISTRO_GUIAS,
  REGISTRO_CORREO,
  REGISTRO_BITACORA,
  REGISTRO_CONTROL_REBAJA,
  REGISTRO_CAJA_DEVOLUCIONES,
  REGISTRO_STOCK_PEDIDOS,
  REGISTRO_DATOS_LIMPIOS,
  REGISTRO_FOTOS,
);
