import { ConstructorNotaDebitoUbl } from '../nucleo/ubl/constructores-cpe';
import type { DocumentoCpe, ResultadoXmlCpe } from '../nucleo/documento-fiscal.types';
import { nombreBaseCpe } from '../nucleo/identificadores-cpe';

/**
 * Builder UBL 2.1 de Nota de Débito (08, raíz DebitNote): motivo del
 * catálogo 10 en cac:DiscrepancyResponse, referencia única al comprobante
 * modificado, cac:RequestedMonetaryTotal y cac:DebitNoteLine/DebitedQuantity.
 * Las líneas llegan YA calculadas (DocumentoCpe): no se recalcula el IGV.
 */
export class NotaDebitoUblBuilder {
  constructor(private readonly constructorUbl: ConstructorNotaDebitoUbl = new ConstructorNotaDebitoUbl()) {}

  build(doc: DocumentoCpe): ResultadoXmlCpe {
    return { xml: this.constructorUbl.construir(doc), nombreBase: nombreBaseCpe(doc.emisor.ruc, doc.tipo, doc.serie, doc.numero) };
  }
}
