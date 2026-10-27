import { VentaDocumentosBussnies } from '../bussnies/Bussnies/venta-documentos.bussnies';
import { VentaDocumentosRepository } from '../repository/Repository/venta-documentos.repository';
import { RegistroModulo } from './registro-modulo';

/**
 * Documentos de una venta (comprobante, notas y guías enlazados) y ventas sin comprobante. Las rutas
 * (GET /venta/:id/documentos y GET /venta/sin-comprobante) viven en VentaController, registrado en
 * app.module.ts, para que la literal quede antes de GET /venta/:id; el negocio usa además ComprobanteBussnies,
 * NotaCreditoBussnies (REGISTRO_NOTAS_CREDITO), GuiaRemisionRepository, EmisionDirecta (REGISTRO_SUNAT_EMISION)
 * y EmisionGre (REGISTRO_SUNAT_GRE).
 */
export const REGISTRO_VENTA_DOCUMENTOS: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [VentaDocumentosRepository, VentaDocumentosBussnies],
};
