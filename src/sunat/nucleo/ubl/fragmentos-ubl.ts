import {
  CATALOGO_05_POR_AFECTACION,
  CATALOGO_52_MONTO_EN_LETRAS,
  CATALOGO_53_DESCUENTO_AFECTA_BASE,
  CONSUMIDOR_FINAL_SUNAT,
  nombreTaxScheme,
} from '../../catalogos/sunat.catalogos';
import { DecimalExacto, Dinero, formatearDecimal } from '../decimal';
import type {
  AfectacionCpe,
  ClienteCpe,
  EmisorCpe,
  FormaPagoCpe,
  LineaCpe,
  MonedaCpe,
  ReferenciaNotaCpe,
  TotalesCpe,
} from '../documento-fiscal.types';
import { identificadorCpe } from '../identificadores-cpe';
import { el, NodoXml } from '../xml/escritor-xml';
import { ID_FIRMA_UBL, URI_FIRMA_UBL } from './espacios-ubl';

const ATRIBUTOS_CATEGORIA_IMPUESTO = {
  schemeID: 'UN/ECE 5305',
  schemeName: 'Tax Category Identifier',
  schemeAgencyName: 'United Nations Economic Commission for Europe',
} as const;
const ATRIBUTOS_PAIS = {
  listID: 'ISO 3166-1',
  listAgencyName: 'United Nations Economic Commission for Europe',
  listName: 'Country',
} as const;
const ATRIBUTOS_UNSPSC = { listID: 'UNSPSC', listAgencyName: 'GS1 US', listName: 'Item Classification' } as const;
const ORDEN_AFECTACIONES: readonly AfectacionCpe[] = ['10', '20', '30'];

/** Decimales que admite SUNAT en cantidades y precios unitarios (n(12,10)). */
const DECIMALES_UNITARIOS = 10;
/** Decimales del factor de descuento (n(3,5)). */
const DECIMALES_FACTOR = 5;

export interface ConfiguracionLineaUbl {
  elemento: 'cac:InvoiceLine' | 'cac:CreditNoteLine' | 'cac:DebitNoteLine';
  elementoCantidad: 'cbc:InvoicedQuantity' | 'cbc:CreditedQuantity' | 'cbc:DebitedQuantity';
  /**
   * Invoice admite cac:AllowanceCharge por línea (catálogo 53, código 00). En
   * las notas el descuento se refleja en un valor unitario neto, para que
   * cantidad × valor unitario = valor de venta sin elementos fuera del esquema.
   */
  descuentoExplicito: boolean;
}

/**
 * Piezas UBL 2.1 comunes a Invoice, CreditNote y DebitNote. No calcula
 * impuestos: escribe los importes de cada línea tal como llegan (ya
 * calculados y validados), con el formato que exige SUNAT.
 */
export class FragmentosUbl21 {
  monto(nombre: string, valor: number | Dinero, moneda: MonedaCpe): NodoXml {
    return el(nombre, { currencyID: moneda }, Dinero.de(valor).toString());
  }

  /** Un único ext:UBLExtension con el ExtensionContent vacío donde irá la firma. */
  extensionesParaFirma(): NodoXml {
    return el('ext:UBLExtensions', null, el('ext:UBLExtension', null, el('ext:ExtensionContent')));
  }

  firma(emisor: { ruc: string; razonSocial: string }): NodoXml {
    return el(
      'cac:Signature',
      null,
      el('cbc:ID', null, ID_FIRMA_UBL),
      el(
        'cac:SignatoryParty',
        null,
        el('cac:PartyIdentification', null, el('cbc:ID', null, emisor.ruc)),
        el('cac:PartyName', null, el('cbc:Name', null, emisor.razonSocial)),
      ),
      el('cac:DigitalSignatureAttachment', null, el('cac:ExternalReference', null, el('cbc:URI', null, URI_FIRMA_UBL))),
    );
  }

  proveedor(emisor: EmisorCpe): NodoXml {
    const texto = (valor?: string | null) => (valor ?? '').trim();
    return el(
      'cac:AccountingSupplierParty',
      null,
      el(
        'cac:Party',
        null,
        el('cac:PartyIdentification', null, el('cbc:ID', { schemeID: '6' }, emisor.ruc)),
        texto(emisor.nombreComercial) ? el('cac:PartyName', null, el('cbc:Name', null, texto(emisor.nombreComercial))) : null,
        el(
          'cac:PartyLegalEntity',
          null,
          el('cbc:RegistrationName', null, emisor.razonSocial),
          el(
            'cac:RegistrationAddress',
            null,
            texto(emisor.ubigeo) ? el('cbc:ID', null, texto(emisor.ubigeo)) : null,
            el('cbc:AddressTypeCode', null, texto(emisor.codigoEstablecimiento) || '0000'),
            texto(emisor.provincia) ? el('cbc:CityName', null, texto(emisor.provincia)) : null,
            texto(emisor.departamento) ? el('cbc:CountrySubentity', null, texto(emisor.departamento)) : null,
            texto(emisor.distrito) ? el('cbc:District', null, texto(emisor.distrito)) : null,
            texto(emisor.direccion) ? el('cac:AddressLine', null, el('cbc:Line', null, texto(emisor.direccion))) : null,
            el('cac:Country', null, el('cbc:IdentificationCode', ATRIBUTOS_PAIS, 'PE')),
          ),
        ),
      ),
    );
  }

  /** Emisor en los documentos UBL 2.0 de SUNAT (resumen diario y comunicación de baja). */
  proveedorResumen(emisor: { ruc: string; razonSocial: string }): NodoXml {
    return el(
      'cac:AccountingSupplierParty',
      null,
      el('cbc:CustomerAssignedAccountID', null, emisor.ruc),
      el('cbc:AdditionalAccountID', null, '6'),
      el('cac:Party', null, el('cac:PartyLegalEntity', null, el('cbc:RegistrationName', null, emisor.razonSocial))),
    );
  }

  cliente(cliente: ClienteCpe): NodoXml {
    const tipo = String(cliente.tipoDoc ?? '').trim();
    const numero = String(cliente.numDoc ?? '').trim() || (tipo === CONSUMIDOR_FINAL_SUNAT.tipoDoc ? CONSUMIDOR_FINAL_SUNAT.numDoc : '');
    const direccion = (cliente.direccion ?? '').trim();
    return el(
      'cac:AccountingCustomerParty',
      null,
      el(
        'cac:Party',
        null,
        el('cac:PartyIdentification', null, el('cbc:ID', { schemeID: tipo }, numero)),
        el(
          'cac:PartyLegalEntity',
          null,
          el('cbc:RegistrationName', null, cliente.nombre),
          direccion ? el('cac:RegistrationAddress', null, el('cac:AddressLine', null, el('cbc:Line', null, direccion))) : null,
        ),
      ),
    );
  }

  /** Leyenda 1000 del catálogo 52: importe total en letras. */
  leyendaMontoEnLetras(texto: string): NodoXml {
    return el('cbc:Note', { languageLocaleID: CATALOGO_52_MONTO_EN_LETRAS }, texto);
  }

  /**
   * Forma de pago (RS 193-2020): Contado, o Credito con el monto neto
   * pendiente y un cac:PaymentTerms por cuota (Cuota001…) con su vencimiento.
   */
  terminosDePago(formaPago: FormaPagoCpe, moneda: MonedaCpe): NodoXml[] {
    const encabezado = (medio: string) => [el('cbc:ID', null, 'FormaPago'), el('cbc:PaymentMeansID', null, medio)];
    if (formaPago.tipo !== 'Credito') {
      return [el('cac:PaymentTerms', null, encabezado('Contado'))];
    }
    const cuotas = formaPago.cuotas ?? [];
    return [
      el('cac:PaymentTerms', null, encabezado('Credito'), this.monto('cbc:Amount', formaPago.montoPendiente ?? 0, moneda)),
      ...cuotas.map((cuota, i) =>
        el(
          'cac:PaymentTerms',
          null,
          encabezado(`Cuota${String(cuota.numero || i + 1).padStart(3, '0')}`),
          this.monto('cbc:Amount', cuota.monto, moneda),
          el('cbc:PaymentDueDate', null, cuota.fechaPago),
        ),
      ),
    ];
  }

  /** cac:TaxTotal del documento: un TaxSubtotal por afectación, sumando las líneas al céntimo. */
  totalImpuestos(lineas: readonly LineaCpe[], moneda: MonedaCpe): NodoXml {
    const grupos = new Map<AfectacionCpe, { base: Dinero; igv: Dinero }>();
    for (const linea of lineas) {
      const actual = grupos.get(linea.afectacion) ?? { base: Dinero.cero(), igv: Dinero.cero() };
      grupos.set(linea.afectacion, { base: actual.base.mas(linea.valorVenta), igv: actual.igv.mas(linea.igv) });
    }
    const totalIgv = Dinero.suma([...grupos.values()].map((g) => g.igv));
    const subtotales = ORDEN_AFECTACIONES.filter((afectacion) => grupos.has(afectacion)).map((afectacion) => {
      const grupo = grupos.get(afectacion)!;
      return el(
        'cac:TaxSubtotal',
        null,
        this.monto('cbc:TaxableAmount', grupo.base, moneda),
        this.monto('cbc:TaxAmount', grupo.igv, moneda),
        el(
          'cac:TaxCategory',
          null,
          el('cbc:ID', ATRIBUTOS_CATEGORIA_IMPUESTO, CATALOGO_05_POR_AFECTACION[afectacion]),
          this.esquemaTributo(afectacion),
        ),
      );
    });
    return el('cac:TaxTotal', null, this.monto('cbc:TaxAmount', totalIgv, moneda), subtotales);
  }

  /** LegalMonetaryTotal (Invoice, CreditNote) o RequestedMonetaryTotal (DebitNote), igual a los totales de entrada. */
  totalesMonetarios(nombre: 'cac:LegalMonetaryTotal' | 'cac:RequestedMonetaryTotal', totales: TotalesCpe, moneda: MonedaCpe): NodoXml {
    const valorVenta = Dinero.suma([totales.gravada, totales.exonerada, totales.inafecta]);
    return el(
      nombre,
      null,
      this.monto('cbc:LineExtensionAmount', valorVenta, moneda),
      this.monto('cbc:TaxInclusiveAmount', totales.total, moneda),
      this.monto('cbc:PayableAmount', totales.total, moneda),
    );
  }

  /** DiscrepancyResponse (motivo y sustento) y un único BillingReference al comprobante modificado. */
  referenciaNota(referencia: ReferenciaNotaCpe): NodoXml[] {
    const id = identificadorCpe(referencia.serie, referencia.numero);
    return [
      el(
        'cac:DiscrepancyResponse',
        null,
        el('cbc:ReferenceID', null, id),
        el('cbc:ResponseCode', null, referencia.motivo),
        el('cbc:Description', null, referencia.sustento),
      ),
      el(
        'cac:BillingReference',
        null,
        el('cac:InvoiceDocumentReference', null, el('cbc:ID', null, id), el('cbc:DocumentTypeCode', null, referencia.tipoDoc)),
      ),
    ];
  }

  linea(config: ConfiguracionLineaUbl, linea: LineaCpe, indice: number, moneda: MonedaCpe): NodoXml {
    const conDescuento = DecimalExacto.de(linea.descuentoBase).comparar(0) > 0;
    // Sin AllowanceCharge el descuento se refleja en el valor unitario neto.
    const valorUnitario = conDescuento && !config.descuentoExplicito
      ? Dinero.de(linea.valorVenta).entre(linea.cantidad, DECIMALES_UNITARIOS)
      : DecimalExacto.de(linea.valorUnitario);

    return el(
      config.elemento,
      null,
      el('cbc:ID', null, indice + 1),
      el(config.elementoCantidad, { unitCode: linea.unidad }, formatearDecimal(linea.cantidad, DECIMALES_UNITARIOS)),
      this.monto('cbc:LineExtensionAmount', linea.valorVenta, moneda),
      el(
        'cac:PricingReference',
        null,
        el(
          'cac:AlternativeConditionPrice',
          null,
          el('cbc:PriceAmount', { currencyID: moneda }, formatearDecimal(linea.precioVentaUnitario, DECIMALES_UNITARIOS, 2)),
          el('cbc:PriceTypeCode', null, '01'),
        ),
      ),
      conDescuento && config.descuentoExplicito ? this.descuentoLinea(linea, moneda) : null,
      this.impuestosLinea(linea, moneda),
      this.item(linea),
      el('cac:Price', null, el('cbc:PriceAmount', { currencyID: moneda }, valorUnitario.aTexto(2, DECIMALES_UNITARIOS))),
    );
  }

  /** cac:AllowanceCharge de la línea: descuento que afecta la base (catálogo 53, código 00). */
  private descuentoLinea(linea: LineaCpe, moneda: MonedaCpe): NodoXml | null {
    const base = Dinero.de(DecimalExacto.de(linea.cantidad).por(linea.valorUnitario));
    if (!base.esPositivo()) return null;
    const descuento = Dinero.de(linea.descuentoBase);
    return el(
      'cac:AllowanceCharge',
      null,
      el('cbc:ChargeIndicator', null, 'false'),
      el('cbc:AllowanceChargeReasonCode', null, CATALOGO_53_DESCUENTO_AFECTA_BASE),
      el('cbc:MultiplierFactorNumeric', null, descuento.aDecimal().entre(base.aDecimal(), DECIMALES_FACTOR).aTexto(2, DECIMALES_FACTOR)),
      this.monto('cbc:Amount', descuento, moneda),
      this.monto('cbc:BaseAmount', base, moneda),
    );
  }

  private impuestosLinea(linea: LineaCpe, moneda: MonedaCpe): NodoXml {
    const porcentaje = linea.afectacion === '10' ? linea.porcentajeIgv : 0;
    return el(
      'cac:TaxTotal',
      null,
      this.monto('cbc:TaxAmount', linea.igv, moneda),
      el(
        'cac:TaxSubtotal',
        null,
        this.monto('cbc:TaxableAmount', linea.valorVenta, moneda),
        this.monto('cbc:TaxAmount', linea.igv, moneda),
        el(
          'cac:TaxCategory',
          null,
          el('cbc:ID', ATRIBUTOS_CATEGORIA_IMPUESTO, CATALOGO_05_POR_AFECTACION[linea.afectacion]),
          el('cbc:Percent', null, formatearDecimal(porcentaje, 2, 2)),
          el('cbc:TaxExemptionReasonCode', null, linea.afectacion),
          this.esquemaTributo(linea.afectacion),
        ),
      ),
    );
  }

  private esquemaTributo(afectacion: AfectacionCpe): NodoXml {
    const esquema = nombreTaxScheme(afectacion);
    return el(
      'cac:TaxScheme',
      null,
      el('cbc:ID', null, esquema.id),
      el('cbc:Name', null, esquema.nombre),
      el('cbc:TaxTypeCode', null, esquema.codigo),
    );
  }

  private item(linea: LineaCpe): NodoXml {
    const codigoInterno = (linea.codigoInterno ?? '').trim();
    const codigoSunat = (linea.codigoSunat ?? '').trim();
    return el(
      'cac:Item',
      null,
      el('cbc:Description', null, linea.descripcion),
      codigoInterno ? el('cac:SellersItemIdentification', null, el('cbc:ID', null, codigoInterno)) : null,
      codigoSunat ? el('cac:CommodityClassification', null, el('cbc:ItemClassificationCode', ATRIBUTOS_UNSPSC, codigoSunat)) : null,
    );
  }
}
