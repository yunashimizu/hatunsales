import { ATRIBUTOS_CATALOGO_01, CATALOGO_51_VENTA_INTERNA } from '../../catalogos/sunat.catalogos';
import type { DocumentoCpe, FormaPagoCpe, TipoCpe } from '../documento-fiscal.types';
import { DocumentoCpeInvalidoError } from '../errores-nucleo';
import { el, HijoXml } from '../xml/escritor-xml';
import { ConstructorUblCpe } from './constructor-ubl-cpe';
import { ESPACIOS_UBL } from './espacios-ubl';
import { ConfiguracionLineaUbl } from './fragmentos-ubl';

/** Motivo 13 del catálogo 09: la única nota de crédito que informa forma de pago. */
const MOTIVO_NC_AJUSTE_CUOTAS = '13';

/** Fecha de vencimiento: la declarada o, al crédito, la de la última cuota. */
function fechaVencimiento(doc: DocumentoCpe): string | undefined {
  if (doc.fechaVencimiento) return doc.fechaVencimiento;
  const cuotas = doc.formaPago?.tipo === 'Credito' ? doc.formaPago.cuotas ?? [] : [];
  return cuotas.reduce<string | undefined>((maxima, cuota) => (!maxima || cuota.fechaPago > maxima ? cuota.fechaPago : maxima), undefined);
}

/**
 * Factura (01) y boleta (03): raíz Invoice. Lleva tipo de operación 0101
 * (venta interna), vencimiento si es al crédito y forma de pago (Contado por
 * omisión, exigida desde la RS 193-2020). Los descuentos por línea van como
 * cac:AllowanceCharge código 00.
 */
export class ConstructorFacturaBoletaUbl extends ConstructorUblCpe {
  readonly tiposSoportados: readonly TipoCpe[] = ['01', '03'];
  protected readonly raiz = { nombre: 'Invoice', espacio: ESPACIOS_UBL.invoice };
  protected readonly configuracionLinea: ConfiguracionLineaUbl = {
    elemento: 'cac:InvoiceLine',
    elementoCantidad: 'cbc:InvoicedQuantity',
    descuentoExplicito: true,
  };
  protected readonly elementoTotales = 'cac:LegalMonetaryTotal' as const;

  protected perfil(): HijoXml {
    return el('cbc:ProfileID', null, CATALOGO_51_VENTA_INTERNA);
  }

  protected cabeceraDelTipo(doc: DocumentoCpe): HijoXml {
    const vencimiento = fechaVencimiento(doc);
    return [
      vencimiento ? el('cbc:DueDate', null, vencimiento) : null,
      el('cbc:InvoiceTypeCode', { listID: CATALOGO_51_VENTA_INTERNA, ...ATRIBUTOS_CATALOGO_01 }, doc.tipo),
    ];
  }

  protected condicionesDePago(doc: DocumentoCpe): HijoXml {
    const formaPago: FormaPagoCpe = doc.formaPago ?? { tipo: 'Contado' };
    return this.fragmentos.terminosDePago(formaPago, doc.moneda);
  }
}

/** Base de las notas: exigen la referencia al comprobante modificado (un único BillingReference). */
abstract class ConstructorNotaUbl extends ConstructorUblCpe {
  protected referencias(doc: DocumentoCpe): HijoXml {
    if (!doc.referencia) {
      throw new DocumentoCpeInvalidoError(['La nota debe indicar el comprobante que modifica (referencia).']);
    }
    return this.fragmentos.referenciaNota(doc.referencia);
  }
}

/**
 * Nota de crédito (07): DiscrepancyResponse (catálogo 09) + BillingReference.
 * Las líneas no llevan AllowanceCharge: el descuento se refleja en el valor
 * unitario neto. Solo el motivo 13 informa la nueva forma de pago.
 */
export class ConstructorNotaCreditoUbl extends ConstructorNotaUbl {
  readonly tiposSoportados: readonly TipoCpe[] = ['07'];
  protected readonly raiz = { nombre: 'CreditNote', espacio: ESPACIOS_UBL.creditNote };
  protected readonly configuracionLinea: ConfiguracionLineaUbl = {
    elemento: 'cac:CreditNoteLine',
    elementoCantidad: 'cbc:CreditedQuantity',
    descuentoExplicito: false,
  };
  protected readonly elementoTotales = 'cac:LegalMonetaryTotal' as const;

  protected condicionesDePago(doc: DocumentoCpe): HijoXml {
    const ajusteDeCuotas = doc.referencia?.motivo === MOTIVO_NC_AJUSTE_CUOTAS && doc.formaPago?.tipo === 'Credito';
    return ajusteDeCuotas ? this.fragmentos.terminosDePago(doc.formaPago!, doc.moneda) : null;
  }
}

/** Nota de débito (08): DiscrepancyResponse (catálogo 10), RequestedMonetaryTotal y DebitNoteLine. */
export class ConstructorNotaDebitoUbl extends ConstructorNotaUbl {
  readonly tiposSoportados: readonly TipoCpe[] = ['08'];
  protected readonly raiz = { nombre: 'DebitNote', espacio: ESPACIOS_UBL.debitNote };
  protected readonly configuracionLinea: ConfiguracionLineaUbl = {
    elemento: 'cac:DebitNoteLine',
    elementoCantidad: 'cbc:DebitedQuantity',
    descuentoExplicito: false,
  };
  protected readonly elementoTotales = 'cac:RequestedMonetaryTotal' as const;
}
