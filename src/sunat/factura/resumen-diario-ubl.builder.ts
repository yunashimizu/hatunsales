import {
  CondicionLineaResumen,
  ConstructorResumenDiarioUbl,
  DatosResumenDiario,
  LineaResumenDiario,
  ResultadoResumenUbl,
  TipoDocumentoResumen as TipoDocumentoResumenNucleo,
} from '../nucleo/ubl/constructor-resumen-diario';

/**
 * Resumen Diario de Boletas y notas vinculadas (SummaryDocuments, UBL 2.0,
 * CustomizationID 1.1), enviado por sendSummary (ticket + getStatus).
 * Plazo: el día de emisión o hasta el 7.º día calendario (RS 114-2019).
 * El XML lo arma ConstructorResumenDiarioUbl del núcleo.
 *
 * Regla corregida: el cbc:ID y el nombre del archivo son el MISMO
 * identificador, RC-<fecha de GENERACIÓN>-<correlativo>; la fecha de emisión
 * de las boletas va en cbc:ReferenceDate.
 */

export { identificadorResumen, nombreArchivoResumen } from '../nucleo/identificadores-cpe';
export { MAXIMO_LINEAS_RESUMEN } from '../nucleo/ubl/constructor-resumen-diario';
export type { DatosResumenDiario, LineaResumenDiario, ResultadoResumenUbl } from '../nucleo/ubl/constructor-resumen-diario';

export type EstadoLineaResumen = CondicionLineaResumen; // 1 Adicionar, 2 Modificar, 3 Anulado
export type TipoDocumentoResumen = TipoDocumentoResumenNucleo; // Boleta, Nota de Credito, Nota de Debito
export type ResumenDiarioLineaInput = LineaResumenDiario;
export type ResumenDiarioUblBuilderInput = DatosResumenDiario;

export class ResumenDiarioUblBuilder {
  constructor(private readonly constructorUbl: ConstructorResumenDiarioUbl = new ConstructorResumenDiarioUbl()) {}

  /** Valida (ResumenInvalidoError) y arma el XML sin firmar; nombreBase = RUC-RC-YYYYMMDD-N. */
  build(input: ResumenDiarioUblBuilderInput): ResultadoResumenUbl {
    return this.constructorUbl.construir(input);
  }

  validar(input: ResumenDiarioUblBuilderInput): string[] {
    return this.constructorUbl.validar(input);
  }
}
