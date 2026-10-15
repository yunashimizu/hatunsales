import { numeroALetras } from '../../../util/fiscal/numero-letras';
import type { DocumentoCpe, MonedaCpe, TipoCpe } from '../documento-fiscal.types';
import { DocumentoCpeInvalidoError, ErrorNucleoFiscal } from '../errores-nucleo';
import { identificadorCpe } from '../identificadores-cpe';
import { el, EscritorXml, HijoXml } from '../xml/escritor-xml';
import { atributosRaizUbl } from './espacios-ubl';
import { ConfiguracionLineaUbl, FragmentosUbl21 } from './fragmentos-ubl';

/** Estrategia que convierte un DocumentoCpe en el XML UBL de su tipo. */
export interface ConstructorXmlDocumentoCpe {
  readonly tiposSoportados: readonly TipoCpe[];
  construir(doc: DocumentoCpe): string;
}

/** Importe total en letras para la leyenda 1000 (CIENTO DIECIOCHO CON 00/100 SOLES). */
export function importeEnLetras(total: number, moneda: MonedaCpe): string {
  return numeroALetras(total, moneda === 'USD' ? 2 : 1);
}

/**
 * Plantilla común de Invoice, CreditNote y DebitNote (UBL 2.1,
 * CustomizationID 2.0). El orden de los elementos sigue el XSD de UBL 2.1:
 * SUNAT valida el esquema y un elemento fuera de lugar rechaza el envío. Cada
 * tipo concreto solo completa sus ganchos (cabecera, referencias, pago).
 */
export abstract class ConstructorUblCpe implements ConstructorXmlDocumentoCpe {
  abstract readonly tiposSoportados: readonly TipoCpe[];
  protected abstract readonly raiz: { nombre: string; espacio: string };
  protected abstract readonly configuracionLinea: ConfiguracionLineaUbl;
  protected abstract readonly elementoTotales: 'cac:LegalMonetaryTotal' | 'cac:RequestedMonetaryTotal';

  constructor(
    protected readonly fragmentos: FragmentosUbl21 = new FragmentosUbl21(),
    private readonly escritor: EscritorXml = new EscritorXml(),
  ) {}

  construir(doc: DocumentoCpe): string {
    this.verificarEstructura(doc);
    const raiz = el(
      this.raiz.nombre,
      atributosRaizUbl(this.raiz.espacio),
      this.fragmentos.extensionesParaFirma(),
      el('cbc:UBLVersionID', null, '2.1'),
      el('cbc:CustomizationID', null, '2.0'),
      this.perfil(doc),
      el('cbc:ID', null, identificadorCpe(doc.serie, doc.numero)),
      el('cbc:IssueDate', null, doc.fechaEmision),
      el('cbc:IssueTime', null, doc.horaEmision),
      this.cabeceraDelTipo(doc),
      this.fragmentos.leyendaMontoEnLetras(this.leyenda(doc)),
      el('cbc:DocumentCurrencyCode', null, doc.moneda),
      this.referencias(doc),
      this.fragmentos.firma(doc.emisor),
      this.fragmentos.proveedor(doc.emisor),
      this.fragmentos.cliente(doc.cliente),
      this.condicionesDePago(doc),
      this.fragmentos.totalImpuestos(doc.lineas, doc.moneda),
      this.fragmentos.totalesMonetarios(this.elementoTotales, doc.totales, doc.moneda),
      doc.lineas.map((linea, indice) => this.fragmentos.linea(this.configuracionLinea, linea, indice, doc.moneda)),
    );
    return this.escritor.serializar(raiz);
  }

  /** cbc:ProfileID (antes del cbc:ID). */
  protected perfil(_doc: DocumentoCpe): HijoXml {
    return null;
  }

  /** Elementos entre cbc:IssueTime y cbc:Note (Invoice: DueDate e InvoiceTypeCode). */
  protected cabeceraDelTipo(_doc: DocumentoCpe): HijoXml {
    return null;
  }

  /** Elementos entre cbc:DocumentCurrencyCode y cac:Signature (notas: DiscrepancyResponse y BillingReference). */
  protected referencias(_doc: DocumentoCpe): HijoXml {
    return null;
  }

  /** cac:PaymentTerms, entre las partes y cac:TaxTotal. */
  protected condicionesDePago(_doc: DocumentoCpe): HijoXml {
    return null;
  }

  protected leyenda(doc: DocumentoCpe): string {
    return doc.leyendaMontoLetras?.trim() || importeEnLetras(doc.totales.total, doc.moneda);
  }

  private verificarEstructura(doc: DocumentoCpe): void {
    if (!doc || !this.tiposSoportados.includes(doc.tipo)) {
      throw new ErrorNucleoFiscal(
        'FISCAL_TIPO_NO_SOPORTADO',
        `El constructor ${this.raiz.nombre} no admite el tipo de comprobante "${doc?.tipo}" (admite ${this.tiposSoportados.join(', ')}).`,
      );
    }
    if (!Array.isArray(doc.lineas) || doc.lineas.length === 0) {
      throw new DocumentoCpeInvalidoError(['El comprobante debe tener al menos una línea.']);
    }
  }
}
