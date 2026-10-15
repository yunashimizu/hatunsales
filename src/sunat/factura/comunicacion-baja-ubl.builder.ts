import { ConstructorComunicacionBajaUbl, DatosComunicacionBaja } from '../nucleo/ubl/constructor-comunicacion-baja';
import type { ResultadoResumenUbl } from '../nucleo/ubl/constructor-resumen-diario';

/**
 * Comunicación de baja (RA, VoidedDocuments UBL 2.0, CustomizationID 1.0)
 * de facturas y sus notas (series F), enviada por sendSummary. Se presenta
 * hasta el 7.º día calendario desde la emisión; fuera de plazo corresponde
 * una nota de crédito. Las boletas se anulan por resumen diario (condición 3).
 * ID y nombre del archivo: RA-<fecha de GENERACIÓN>-<correlativo>.
 */

export { bajaDentroDePlazo, MAXIMO_LINEAS_BAJA } from '../nucleo/ubl/constructor-comunicacion-baja';
export type { DatosComunicacionBaja, LineaComunicacionBaja, TipoDocumentoBaja } from '../nucleo/ubl/constructor-comunicacion-baja';
export { identificadorResumen, nombreArchivoResumen } from '../nucleo/identificadores-cpe';

export class ComunicacionBajaUblBuilder {
  constructor(private readonly constructorUbl: ConstructorComunicacionBajaUbl = new ConstructorComunicacionBajaUbl()) {}

  /** Valida (BajaInvalidaError) y arma el XML sin firmar; nombreBase = RUC-RA-YYYYMMDD-N. */
  build(input: DatosComunicacionBaja): ResultadoResumenUbl {
    return this.constructorUbl.construir(input);
  }

  validar(input: DatosComunicacionBaja): string[] {
    return this.constructorUbl.validar(input);
  }
}
