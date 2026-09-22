/**
 * Builder UBL 2.1 para la Guía de Remisión Electrónica Remitente (09),
 * root DespatchAdvice.
 *
 * ADVERTENCIA DE ALCANCE (a diferencia de Invoice/CreditNote/SummaryDocuments,
 * que se verificaron contra ejemplos oficiales de SUNAT letra por letra):
 * el detalle fino de esta plantilla se construyó con la estructura estándar
 * de UBL 2.1 DespatchAdvice + los catálogos 20/21 de SUNAT, SIN poder leer
 * un ejemplo XML oficial completo en esta sesión (el PDF legado de SUNAT
 * para GRE no respondió, y desde ~2023 SUNAT prioriza el envío de GRE por
 * la "Plataforma Nueva GRE" (API REST/OAuth2), no solo por el SOAP clásico).
 * Antes de un envío real de GRE a SUNAT, hay que:
 *  1) confirmar esta plantilla contra la guía XML vigente de GRE en
 *     cpe.sunat.gob.pe, y
 *  2) decidir si se envía por el SOAP clásico (mismo patrón que
 *     Factura/Boleta/NC, endpoint propio de GRE) o por la Plataforma Nueva
 *     GRE (REST/OAuth2) — ver fiscal-config.ts para los endpoints de ambas.
 */

export interface GuiaRemisionItemUblInput {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  codigoProducto?: string;
}

export interface GuiaRemisionUblBuilderInput {
  serie: string;
  numero: number;
  fechaEmision: string;
  emisor: { ruc: string; razonSocial: string };
  destinatario: { tipoDocumento: string; numeroDocumento: string; razonSocial: string };
  motivoTraslado: string; // catalogo 20
  modalidadTraslado: string; // catalogo 21 (01 transporte publico, 02 privado)
  pesoBrutoTotalKg: number;
  origenUbigeo: string;
  origenDireccion: string;
  destinoUbigeo: string;
  destinoDireccion: string;
  fechaInicioTraslado: string;
  transportista?: { ruc: string; razonSocial: string };
  vehiculoPlaca?: string;
  conductorNumeroDocumento?: string;
  conductorLicencia?: string;
  items: GuiaRemisionItemUblInput[];
}

export class GuiaRemisionUblBuilder {
  build(input: GuiaRemisionUblBuilderInput): { xml: string } {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"
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
  <cbc:DespatchAdviceTypeCode>09</cbc:DespatchAdviceTypeCode>
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
        <cbc:URI>#SunatSignature</cbc:URI>
      </cac:ExternalReference>
    </cac:DigitalSignatureAttachment>
  </cac:Signature>
  <cac:DespatchSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="6">${input.emisor.ruc}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.emisor.razonSocial)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:DespatchSupplierParty>
  <cac:DeliveryCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${input.destinatario.tipoDocumento}">${input.destinatario.numeroDocumento}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.destinatario.razonSocial)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:DeliveryCustomerParty>
  <cac:Shipment>
    <cbc:ID>${input.serie}-${this.padNumero(input.numero)}</cbc:ID>
    <cbc:HandlingCode>${input.motivoTraslado}</cbc:HandlingCode>
    <cbc:GrossWeightMeasure unitCode="KGM">${this.redondear(input.pesoBrutoTotalKg)}</cbc:GrossWeightMeasure>
    <cac:Delivery>
      <cac:DeliveryAddress>
        <cbc:ID>${input.destinoUbigeo}</cbc:ID>
        <cac:AddressLine>
          <cbc:Line>${this.escapeXml(input.destinoDireccion)}</cbc:Line>
        </cac:AddressLine>
      </cac:DeliveryAddress>
    </cac:Delivery>
    <cac:OriginAddress>
      <cbc:ID>${input.origenUbigeo}</cbc:ID>
      <cac:AddressLine>
        <cbc:Line>${this.escapeXml(input.origenDireccion)}</cbc:Line>
      </cac:AddressLine>
    </cac:OriginAddress>
    <cac:ShipmentStage>
      <cbc:TransportModeCode>${input.modalidadTraslado}</cbc:TransportModeCode>
      <cbc:TransitPeriod>
        <cbc:StartDate>${input.fechaInicioTraslado}</cbc:StartDate>
      </cbc:TransitPeriod>
      ${input.transportista ? `
      <cac:CarrierParty>
        <cac:PartyIdentification>
          <cbc:ID schemeID="6">${input.transportista.ruc}</cbc:ID>
        </cac:PartyIdentification>
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>${this.escapeXml(input.transportista.razonSocial)}</cbc:RegistrationName>
        </cac:PartyLegalEntity>
      </cac:CarrierParty>` : ''}
      ${input.vehiculoPlaca ? `
      <cac:TransportMeans>
        <cac:RoadTransport>
          <cbc:LicensePlateID>${this.escapeXml(input.vehiculoPlaca)}</cbc:LicensePlateID>
        </cac:RoadTransport>
      </cac:TransportMeans>` : ''}
      ${input.conductorNumeroDocumento ? `
      <cac:DriverPerson>
        <cbc:ID>${input.conductorNumeroDocumento}</cbc:ID>
        ${input.conductorLicencia ? `<cbc:JobTitle>${this.escapeXml(input.conductorLicencia)}</cbc:JobTitle>` : ''}
      </cac:DriverPerson>` : ''}
    </cac:ShipmentStage>
  </cac:Shipment>
  ${input.items.map((item, index) => `
  <cac:DespatchLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:DeliveredQuantity unitCode="${item.unidadMedida}">${item.cantidad}</cbc:DeliveredQuantity>
    <cac:Item>
      <cbc:Description>${this.escapeXml(item.descripcion)}</cbc:Description>
      ${item.codigoProducto ? `<cac:SellersItemIdentification><cbc:ID>${this.escapeXml(item.codigoProducto)}</cbc:ID></cac:SellersItemIdentification>` : ''}
    </cac:Item>
  </cac:DespatchLine>`).join('')}
</DespatchAdvice>`;

    return { xml };
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
