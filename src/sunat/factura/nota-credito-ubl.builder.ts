import { AfectacionIgv, CATALOGO_05_POR_AFECTACION, nombreTaxScheme } from '../catalogos/sunat.catalogos';

/**
 * Builder UBL 2.1 para Nota de Credito electronica (07/NCR). El esquema
 * CreditNote de UBL 2.1 comparte casi toda su estructura con Invoice
 * (mismos bloques de Party/TaxTotal/LegalMonetaryTotal); lo propio de la
 * Nota de Credito es la referencia obligatoria y duplicada al documento que
 * modifica: cac:BillingReference/cac:InvoiceDocumentReference (serie-numero
 * + tipo de documento, catalogo 01) y cac:DiscrepancyResponse (motivo,
 * catalogo 09, + sustento en texto libre) — verificado en la Guia XML de
 * Nota de Credito de SUNAT y el Anexo 8 de la RS 193-2020/SUNAT.
 */

export interface NotaCreditoItemUblInput {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  precioUnitario: number;
  afectacionIgv: AfectacionIgv;
  descuento?: number;
}

export interface NotaCreditoUblBuilderInput {
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  emisor: {
    ruc: string;
    razonSocial: string;
    direccion?: string;
    ubigeo?: string;
  };
  cliente: {
    tipoDocumento: string;
    numeroDocumento: string;
    razonSocial: string;
  };
  documentoModificado: {
    tipoDocumento: '01' | '03';
    serie: string;
    numero: number;
  };
  motivo: string;
  sustento: string;
  items: NotaCreditoItemUblInput[];
}

export interface NotaCreditoUblBuilderResultado {
  xml: string;
  totalIgv: number;
  totalGeneral: number;
}

export class NotaCreditoUblBuilder {
  build(input: NotaCreditoUblBuilderInput): NotaCreditoUblBuilderResultado {
    const items = input.items.map((item) => this.calcularItem(item, input.moneda));
    const totalIgv = items.reduce((acc, item) => acc + item.igv, 0);
    const totalGeneral = items.reduce((acc, item) => acc + item.total, 0);
    const totalGravadaEtc = items.reduce((acc, item) => acc + item.subtotal, 0);

    const referenciaDocumento = `${input.documentoModificado.serie}-${this.padNumero(input.documentoModificado.numero)}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
            xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
            xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
            xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
            xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>${input.serie}-${this.padNumero(input.numero)}</cbc:ID>
  <cbc:IssueDate>${input.fechaEmision}</cbc:IssueDate>
  <cbc:IssueTime>${input.horaEmision}</cbc:IssueTime>
  <cbc:DocumentCurrencyCode>${input.moneda}</cbc:DocumentCurrencyCode>
  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>${referenciaDocumento}</cbc:ReferenceID>
    <cbc:ResponseCode>${input.motivo}</cbc:ResponseCode>
    <cbc:Description>${this.escapeXml(input.sustento)}</cbc:Description>
  </cac:DiscrepancyResponse>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${referenciaDocumento}</cbc:ID>
      <cbc:DocumentTypeCode>${input.documentoModificado.tipoDocumento}</cbc:DocumentTypeCode>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:Signature>
    <cbc:ID>${input.emisor.ruc}</cbc:ID>
    <cac:SignatoryParty>
      <cac:PartyIdentification>
        <cbc:ID>${input.emisor.ruc}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${this.escapeXml(input.emisor.razonSocial)}</cbc:Name>
      </cac:PartyName>
    </cac:SignatoryParty>
    <cac:DigitalSignatureAttachment>
      <cac:ExternalReference>
        <cbc:URI>#SignatureSUNAT</cbc:URI>
      </cac:ExternalReference>
    </cac:DigitalSignatureAttachment>
  </cac:Signature>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="6">${input.emisor.ruc}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.emisor.razonSocial)}</cbc:RegistrationName>
        <cac:RegistrationAddress>
          <cbc:ID>${input.emisor.ubigeo ?? ''}</cbc:ID>
          <cac:AddressLine>
            <cbc:Line>${this.escapeXml(input.emisor.direccion ?? '')}</cbc:Line>
          </cac:AddressLine>
        </cac:RegistrationAddress>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${input.cliente.tipoDocumento}">${input.cliente.numeroDocumento}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.cliente.razonSocial)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.moneda}">${this.redondear(totalIgv)}</cbc:TaxAmount>
    ${this.taxSubtotales(items, input.moneda)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.moneda}">${this.redondear(totalGravadaEtc)}</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.moneda}">${this.redondear(totalGeneral)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.moneda}">${this.redondear(totalGeneral)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${items.map((item, index) => this.lineaXml(item, index, input.moneda)).join('')}
</CreditNote>`;

    return { xml, totalIgv, totalGeneral };
  }

  private calcularItem(item: NotaCreditoItemUblInput, moneda: 'PEN' | 'USD') {
    const cantidad = Number(item.cantidad ?? 0);
    const precio = Number(item.precioUnitario ?? 0);
    const descuento = Number(item.descuento ?? 0);
    const subtotal = Math.max(cantidad * precio - descuento, 0);
    const igv = item.afectacionIgv === '10' ? Number((subtotal * 0.18).toFixed(2)) : 0;

    return { ...item, cantidad, precioUnitario: precio, subtotal, igv, total: subtotal + igv, moneda };
  }

  private taxSubtotales(items: ReturnType<NotaCreditoUblBuilder['calcularItem']>[], moneda: 'PEN' | 'USD'): string {
    const grupos = new Map<AfectacionIgv, { base: number; igv: number }>();
    for (const item of items) {
      const actual = grupos.get(item.afectacionIgv) ?? { base: 0, igv: 0 };
      actual.base += item.subtotal;
      actual.igv += item.igv;
      grupos.set(item.afectacionIgv, actual);
    }

    return Array.from(grupos.entries()).map(([afectacion, valores]) => {
      const scheme = nombreTaxScheme(afectacion);
      return `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${moneda}">${this.redondear(valores.base)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${moneda}">${this.redondear(valores.igv)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="UN/ECE 5305" schemeAgencyName="United Nations Economic Commission for Europe">${CATALOGO_05_POR_AFECTACION[afectacion]}</cbc:ID>
        <cbc:Percent>${afectacion === '10' ? '18.00' : '0.00'}</cbc:Percent>
        <cbc:TaxExemptionReasonCode>${afectacion}</cbc:TaxExemptionReasonCode>
        <cac:TaxScheme>
          <cbc:ID>${scheme.id}</cbc:ID>
          <cbc:Name>${scheme.nombre}</cbc:Name>
          <cbc:TaxTypeCode>${scheme.codigo}</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
    }).join('');
  }

  private lineaXml(item: ReturnType<NotaCreditoUblBuilder['calcularItem']>, index: number, moneda: 'PEN' | 'USD'): string {
    const scheme = nombreTaxScheme(item.afectacionIgv);
    return `
  <cac:CreditNoteLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:CreditedQuantity unitCode="${item.unidadMedida}">${item.cantidad}</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="${moneda}">${this.redondear(item.subtotal)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${moneda}">${this.redondear(item.igv)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${moneda}">${this.redondear(item.subtotal)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${moneda}">${this.redondear(item.igv)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID schemeID="UN/ECE 5305" schemeAgencyName="United Nations Economic Commission for Europe">${CATALOGO_05_POR_AFECTACION[item.afectacionIgv]}</cbc:ID>
          <cbc:Percent>${item.afectacionIgv === '10' ? '18.00' : '0.00'}</cbc:Percent>
          <cbc:TaxExemptionReasonCode>${item.afectacionIgv}</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme>
            <cbc:ID>${scheme.id}</cbc:ID>
            <cbc:Name>${scheme.nombre}</cbc:Name>
            <cbc:TaxTypeCode>${scheme.codigo}</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${this.escapeXml(item.descripcion)}</cbc:Description>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${moneda}">${this.redondear(item.precioUnitario)}</cbc:PriceAmount>
    </cac:Price>
  </cac:CreditNoteLine>`;
  }

  private redondear(valor: number): string {
    return Number(valor || 0).toFixed(2);
  }

  private padNumero(numero: number): string {
    return String(numero).padStart(8, '0');
  }

  private escapeXml(valor: string): string {
    return String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
