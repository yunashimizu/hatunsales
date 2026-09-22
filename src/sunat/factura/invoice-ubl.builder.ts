import { AfectacionIgv, CATALOGO_05_POR_AFECTACION, nombreTaxScheme } from '../catalogos/sunat.catalogos';

/**
 * Builder UBL 2.1 compartido por Factura (01) y Boleta (03): ambas usan el
 * mismo elemento raiz <Invoice>, solo cambia InvoiceTypeCode, el tipo de
 * documento del cliente permitido y la serie. Reemplaza a los dos templates
 * inline que existian antes (factura-beta.service.ts y el
 * factura-ubl.builder.ts sin usar) y corrige lo que SUNAT observa hoy:
 *  - direccion/ubigeo del emisor SI se incluyen (antes se recibian y se
 *    descartaban).
 *  - cac:PaymentTerms (FormaPago Contado/Credito), exigido desde RS 193-2020.
 *  - cac:TaxCategory ahora incluye el cbc:ID corto del catalogo 05
 *    (S/E/O/Z), ademas del cbc:TaxExemptionReasonCode (catalogo 07) que ya
 *    existia.
 *  - un unico cac:Signature a nivel de Invoice, referenciando la firma real
 *    que coloca FacturaBetaFirmaService dentro de ext:UBLExtensions (antes
 *    quedaba un <ds:Signature/> vacio y duplicado).
 */

export interface InvoiceItemUblInput {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  precioUnitario: number;
  afectacionIgv: AfectacionIgv;
  descuento?: number;
}

export interface InvoiceDireccionUblInput {
  direccion?: string;
  ubigeo?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
}

export interface InvoiceEmisorUblInput extends InvoiceDireccionUblInput {
  ruc: string;
  razonSocial: string;
}

export interface InvoiceClienteUblInput {
  tipoDocumento: string; // catalogo 06: '1' DNI, '6' RUC, '0' sin documento
  numeroDocumento: string;
  razonSocial: string;
  direccion?: string;
}

export type FormaPago = 'Contado' | 'Credito';

export interface InvoiceUblBuilderInput {
  tipoDocumento: '01' | '03';
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  formaPago: FormaPago;
  emisor: InvoiceEmisorUblInput;
  cliente: InvoiceClienteUblInput;
  items: InvoiceItemUblInput[];
  observacion?: string;
}

export interface InvoiceUblBuilderResultado {
  xml: string;
  totalGravada: number;
  totalExonerada: number;
  totalInafecta: number;
  totalIgv: number;
  totalGeneral: number;
}

export class InvoiceUblBuilder {
  build(input: InvoiceUblBuilderInput): InvoiceUblBuilderResultado {
    const items = input.items.map((item) => this.calcularItem(item, input.moneda));

    const totalGravada = this.sumar(items, '10');
    const totalExonerada = this.sumar(items, '20');
    const totalInafecta = this.sumar(items, '30') + this.sumar(items, '40');
    const totalIgv = items.reduce((acc, item) => acc + item.igv, 0);
    const totalGeneral = items.reduce((acc, item) => acc + item.total, 0);

    const profileId = input.tipoDocumento === '01' ? '0101' : '0101';
    const perceptorTipo = input.tipoDocumento === '01' ? '6' : input.cliente.tipoDocumento;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
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
  <cbc:ProfileID>${profileId}</cbc:ProfileID>
  <cbc:ID>${input.serie}-${this.padNumero(input.numero)}</cbc:ID>
  <cbc:IssueDate>${input.fechaEmision}</cbc:IssueDate>
  <cbc:IssueTime>${input.horaEmision}</cbc:IssueTime>
  <cbc:InvoiceTypeCode listID="${profileId}">${input.tipoDocumento}</cbc:InvoiceTypeCode>
  ${input.observacion ? `<cbc:Note languageLocaleID="1000">${this.escapeXml(input.observacion)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${input.moneda}</cbc:DocumentCurrencyCode>
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
          <cbc:AddressTypeCode>0000</cbc:AddressTypeCode>
          <cbc:CitySubdivisionName>${this.escapeXml(input.emisor.distrito ?? '')}</cbc:CitySubdivisionName>
          <cbc:CityName>${this.escapeXml(input.emisor.provincia ?? '')}</cbc:CityName>
          <cbc:CountrySubentity>${this.escapeXml(input.emisor.departamento ?? '')}</cbc:CountrySubentity>
          <cac:AddressLine>
            <cbc:Line>${this.escapeXml(input.emisor.direccion ?? '')}</cbc:Line>
          </cac:AddressLine>
          <cac:Country>
            <cbc:IdentificationCode listID="ISO 3166-1" listAgencyName="United Nations Economic Commission for Europe" listName="Country">PE</cbc:IdentificationCode>
          </cac:Country>
        </cac:RegistrationAddress>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${perceptorTipo}">${input.cliente.numeroDocumento}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.cliente.razonSocial)}</cbc:RegistrationName>
        ${input.cliente.direccion ? `<cac:RegistrationAddress><cac:AddressLine><cbc:Line>${this.escapeXml(input.cliente.direccion)}</cbc:Line></cac:AddressLine></cac:RegistrationAddress>` : ''}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentTerms>
    <cbc:ID>FormaPago</cbc:ID>
    <cbc:PaymentMeansID>${input.formaPago}</cbc:PaymentMeansID>
    ${input.formaPago === 'Contado'
      ? `<cbc:Amount currencyID="${input.moneda}">${this.redondear(totalGeneral)}</cbc:Amount>`
      : `<cbc:Amount currencyID="${input.moneda}">0.00</cbc:Amount>`}
  </cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.moneda}">${this.redondear(totalIgv)}</cbc:TaxAmount>
    ${this.taxSubtotales(items, input.moneda)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.moneda}">${this.redondear(totalGravada + totalExonerada + totalInafecta)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.moneda}">${this.redondear(totalGravada + totalExonerada + totalInafecta)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.moneda}">${this.redondear(totalGeneral)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.moneda}">${this.redondear(totalGeneral)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${items.map((item, index) => this.lineaXml(item, index, input.moneda)).join('')}
</Invoice>`;

    return { xml, totalGravada, totalExonerada, totalInafecta, totalIgv, totalGeneral };
  }

  private calcularItem(item: InvoiceItemUblInput, moneda: 'PEN' | 'USD') {
    const cantidad = Number(item.cantidad ?? 0);
    const precio = Number(item.precioUnitario ?? 0);
    const descuento = Number(item.descuento ?? 0);
    const subtotal = Math.max(cantidad * precio - descuento, 0);
    const igv = item.afectacionIgv === '10' ? Number((subtotal * 0.18).toFixed(2)) : 0;

    return {
      descripcion: item.descripcion,
      cantidad,
      unidadMedida: item.unidadMedida,
      precioUnitario: precio,
      afectacionIgv: item.afectacionIgv,
      descuento,
      subtotal,
      igv,
      total: subtotal + igv,
      moneda,
    };
  }

  private sumar(items: ReturnType<InvoiceUblBuilder['calcularItem']>[], afectacion: AfectacionIgv): number {
    return items.filter((item) => item.afectacionIgv === afectacion).reduce((acc, item) => acc + item.subtotal, 0);
  }

  private taxSubtotales(items: ReturnType<InvoiceUblBuilder['calcularItem']>[], moneda: 'PEN' | 'USD'): string {
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

  private lineaXml(item: ReturnType<InvoiceUblBuilder['calcularItem']>, index: number, moneda: 'PEN' | 'USD'): string {
    const scheme = nombreTaxScheme(item.afectacionIgv);
    return `
  <cac:InvoiceLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${item.unidadMedida}">${item.cantidad}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${moneda}">${this.redondear(item.subtotal)}</cbc:LineExtensionAmount>
    <cac:PricingReference>
      <cac:AlternativeConditionPrice>
        <cbc:PriceAmount currencyID="${moneda}">${this.redondear(item.precioUnitario + item.igv / item.cantidad)}</cbc:PriceAmount>
        <cbc:PriceTypeCode>01</cbc:PriceTypeCode>
      </cac:AlternativeConditionPrice>
    </cac:PricingReference>
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
  </cac:InvoiceLine>`;
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
