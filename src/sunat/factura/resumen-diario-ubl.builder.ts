/**
 * Builder UBL 2.0 para el Resumen Diario de Boletas de Venta Electronicas y
 * Notas Electronicas vinculadas (root SummaryDocuments), que se envia por
 * sendSummary (no por sendBill: SUNAT responde con un ticket, el CDR se
 * consulta despues con getStatus).
 *
 * A diferencia de Factura/Boleta/NC (UBL 2.1, namespace Invoice-2/CreditNote-2),
 * el Resumen usa UBL 2.0 y el namespace propio de SUNAT "sac" para sus
 * elementos especificos (SummaryDocumentsLine, TotalAmount, BillingPayment).
 * Estructura y ejemplo verificados contra la "Guia de elaboracion de Resumen
 * Diario de Boletas de Venta electronicas y Notas electronicas" (SUNAT,
 * cpe.sunat.gob.pe, version 2, enero 2018).
 *
 * Plazo legal: mismo dia de emision o hasta el 7mo dia calendario siguiente
 * (Anexo 05-A de la RS 097-2012/SUNAT, modificado por RS 114-2019/SUNAT).
 *
 * Alcance: no incluye percepcion (sac:SUNATPerceptionSummaryDocumentReference),
 * al ser condicional y no aplicar a un negocio que no sea agente de percepcion.
 */

export type EstadoLineaResumen = 1 | 2 | 3; // 1 Adicionar, 2 Modificar, 3 Anulado
export type TipoDocumentoResumen = '03' | '07' | '08'; // Boleta, Nota de Credito, Nota de Debito

export interface ResumenDiarioLineaInput {
  numeroLinea: number;
  tipoDocumento: TipoDocumentoResumen;
  serie: string;
  numero: number;
  tipoDocumentoCliente: string;
  numeroDocumentoCliente: string;
  gravada: number;
  exonerada: number;
  inafecta: number;
  gratuita: number;
  igv: number;
  isc?: number;
  otrosTributos?: number;
  total: number;
  estado: EstadoLineaResumen;
  /** Solo para lineas de Nota de Credito/Debito (tipoDocumento 07/08): la boleta que modifican. */
  documentoModificado?: { tipoDocumento: '03' | '12'; serie: string; numero: number };
}

export interface ResumenDiarioUblBuilderInput {
  identificador: string; // formato RC-YYYYMMDD-##### (ver seccion 1.3 y A.1 de la guia oficial)
  fechaGeneracion: string; // yyyy-mm-dd
  fechaEmisionDocumentos: string; // yyyy-mm-dd
  emisor: { ruc: string; razonSocial: string };
  lineas: ResumenDiarioLineaInput[];
}

export class ResumenDiarioUblBuilder {
  build(input: ResumenDiarioUblBuilderInput): { xml: string } {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SummaryDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1"
                   xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
                   xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
                   xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
                   xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1"
                   xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>2.0</cbc:UBLVersionID>
  <cbc:CustomizationID>1.1</cbc:CustomizationID>
  <cbc:ID>${input.identificador}</cbc:ID>
  <cbc:ReferenceDate>${input.fechaEmisionDocumentos}</cbc:ReferenceDate>
  <cbc:IssueDate>${input.fechaGeneracion}</cbc:IssueDate>
  <cac:Signature>
    <cbc:ID>SunatSignature</cbc:ID>
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
  <cac:AccountingSupplierParty>
    <cbc:CustomerAssignedAccountID>${input.emisor.ruc}</cbc:CustomerAssignedAccountID>
    <cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${this.escapeXml(input.emisor.razonSocial)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  ${input.lineas.map((linea) => this.lineaXml(linea)).join('')}
</SummaryDocuments>`;

    return { xml };
  }

  private lineaXml(linea: ResumenDiarioLineaInput): string {
    const totalOtrosTributos = Number(linea.otrosTributos ?? 0);
    const totalIsc = Number(linea.isc ?? 0);

    return `
  <sac:SummaryDocumentsLine>
    <cbc:LineID>${linea.numeroLinea}</cbc:LineID>
    <cbc:DocumentTypeCode>${linea.tipoDocumento}</cbc:DocumentTypeCode>
    <cbc:ID>${linea.serie}-${this.padNumero(linea.numero)}</cbc:ID>
    <cac:AccountingCustomerParty>
      <cbc:CustomerAssignedAccountID>${linea.numeroDocumentoCliente || '-'}</cbc:CustomerAssignedAccountID>
      <cbc:AdditionalAccountID>${linea.tipoDocumentoCliente}</cbc:AdditionalAccountID>
    </cac:AccountingCustomerParty>
    ${linea.documentoModificado ? `
    <cac:BillingReference>
      <cac:InvoiceDocumentReference>
        <cbc:ID>${linea.documentoModificado.serie}-${this.padNumero(linea.documentoModificado.numero)}</cbc:ID>
        <cbc:DocumentTypeCode>${linea.documentoModificado.tipoDocumento}</cbc:DocumentTypeCode>
      </cac:InvoiceDocumentReference>
    </cac:BillingReference>` : ''}
    <cac:Status>
      <cbc:ConditionCode>${linea.estado}</cbc:ConditionCode>
    </cac:Status>
    <sac:TotalAmount currencyID="PEN">${this.redondear(linea.total)}</sac:TotalAmount>
    <sac:BillingPayment>
      <cbc:PaidAmount currencyID="PEN">${this.redondear(linea.gravada)}</cbc:PaidAmount>
      <cbc:InstructionID>01</cbc:InstructionID>
    </sac:BillingPayment>
    <sac:BillingPayment>
      <cbc:PaidAmount currencyID="PEN">${this.redondear(linea.exonerada)}</cbc:PaidAmount>
      <cbc:InstructionID>02</cbc:InstructionID>
    </sac:BillingPayment>
    <sac:BillingPayment>
      <cbc:PaidAmount currencyID="PEN">${this.redondear(linea.inafecta)}</cbc:PaidAmount>
      <cbc:InstructionID>03</cbc:InstructionID>
    </sac:BillingPayment>
    <sac:BillingPayment>
      <cbc:PaidAmount currencyID="PEN">${this.redondear(linea.gratuita)}</cbc:PaidAmount>
      <cbc:InstructionID>05</cbc:InstructionID>
    </sac:BillingPayment>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">${this.redondear(linea.igv)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="PEN">${this.redondear(linea.igv)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:ID>1000</cbc:ID>
            <cbc:Name>IGV</cbc:Name>
            <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">${this.redondear(totalIsc)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="PEN">${this.redondear(totalIsc)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:ID>2000</cbc:ID>
            <cbc:Name>ISC</cbc:Name>
            <cbc:TaxTypeCode>EXC</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">${this.redondear(totalOtrosTributos)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="PEN">${this.redondear(totalOtrosTributos)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:ID>9999</cbc:ID>
            <cbc:Name>OTROS</cbc:Name>
            <cbc:TaxTypeCode>OTH</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
  </sac:SummaryDocumentsLine>`;
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
