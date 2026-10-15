import { DOMParser } from '@xmldom/xmldom';
import { construirXmlCpe, construirXmlCpeValidado, FabricaConstructoresXmlCpe } from './construir-xml-cpe';
import type { DocumentoCpe } from './documento-fiscal.types';
import { DocumentoCpeInvalidoError, ErrorNucleoFiscal } from './errores-nucleo';
import { boletaPrueba, facturaPrueba, HOY_PRUEBA, notaCreditoPrueba, notaDebitoPrueba } from './pruebas/documentos-prueba-spec';
import { ESPACIOS_UBL } from './ubl/espacios-ubl';

const CBC = ESPACIOS_UBL.cbc;
const CAC = ESPACIOS_UBL.cac;

function parsear(xml: string): Document {
  const errores: string[] = [];
  const documento = new DOMParser({
    errorHandler: { warning: () => undefined, error: (m) => errores.push(String(m)), fatalError: (m) => errores.push(String(m)) },
  }).parseFromString(xml, 'text/xml');
  expect(errores).toEqual([]);
  return documento;
}

function hijosElemento(padre: Element): Element[] {
  const lista: Element[] = [];
  for (let i = 0; i < padre.childNodes.length; i++) {
    const nodo = padre.childNodes.item(i);
    if (nodo.nodeType === 1) lista.push(nodo as Element);
  }
  return lista;
}

/** Descendiente por ruta de nombres locales (cada paso: hijo directo). */
function en(padre: Element, ...ruta: string[]): Element {
  let actual = padre;
  for (const nombre of ruta) {
    const siguiente = hijosElemento(actual).find((e) => e.localName === nombre);
    if (!siguiente) throw new Error(`No existe ${nombre} bajo ${actual.localName} (ruta ${ruta.join('/')})`);
    actual = siguiente;
  }
  return actual;
}

function todos(padre: Element, nombre: string): Element[] {
  return hijosElemento(padre).filter((e) => e.localName === nombre);
}

function texto(padre: Element, ...ruta: string[]): string {
  return (en(padre, ...ruta).textContent ?? '').trim();
}

describe('construirXmlCpe', () => {
  describe('factura de un ítem de S/ 10.00 con IGV', () => {
    const { xml, nombreBase } = construirXmlCpe(facturaPrueba());
    const raiz = parsear(xml).documentElement;

    it('es un Invoice UBL 2.1 bien formado con nombre base RUC-TT-SERIE-NNNNNNNN', () => {
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(raiz.localName).toBe('Invoice');
      expect(raiz.namespaceURI).toBe(ESPACIOS_UBL.invoice);
      expect(nombreBase).toBe('20610206337-01-FFF1-00000007');
      expect(texto(raiz, 'UBLVersionID')).toBe('2.1');
      expect(texto(raiz, 'CustomizationID')).toBe('2.0');
      expect(texto(raiz, 'ProfileID')).toBe('0101');
      expect(texto(raiz, 'ID')).toBe('FFF1-00000007');
      expect(texto(raiz, 'IssueDate')).toBe(HOY_PRUEBA);
      expect(texto(raiz, 'IssueTime')).toBe('10:30:00');
      const tipo = en(raiz, 'InvoiceTypeCode');
      expect(tipo.textContent).toBe('01');
      expect(tipo.getAttribute('listID')).toBe('0101');
      expect(tipo.getAttribute('listURI')).toBe('urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01');
      expect(texto(raiz, 'DocumentCurrencyCode')).toBe('PEN');
    });

    it('lleva un único ext:UBLExtension con ExtensionContent vacío y cac:Signature IDSignSP → #SignatureSP', () => {
      const extensiones = todos(raiz, 'UBLExtensions');
      expect(extensiones).toHaveLength(1);
      expect(todos(extensiones[0], 'UBLExtension')).toHaveLength(1);
      expect(hijosElemento(en(raiz, 'UBLExtensions', 'UBLExtension', 'ExtensionContent'))).toHaveLength(0);
      expect(texto(raiz, 'Signature', 'ID')).toBe('IDSignSP');
      expect(texto(raiz, 'Signature', 'DigitalSignatureAttachment', 'ExternalReference', 'URI')).toBe('#SignatureSP');
    });

    it('leyenda 1000 con el monto en letras', () => {
      const nota = en(raiz, 'Note');
      expect(nota.getAttribute('languageLocaleID')).toBe('1000');
      expect(nota.textContent).toBe('DIEZ CON 00/100 SOLES');
    });

    it('emisor con dirección completa y nombre comercial; adquirente con RUC', () => {
      const parte = en(raiz, 'AccountingSupplierParty', 'Party');
      const id = en(parte, 'PartyIdentification', 'ID');
      expect(id.getAttribute('schemeID')).toBe('6');
      expect(id.textContent).toBe('20610206337');
      expect(texto(parte, 'PartyName', 'Name')).toBe('HATUNSALES');
      expect(texto(parte, 'PartyLegalEntity', 'RegistrationName')).toBe('HATUNSALES S.A.C.');
      const direccion = en(parte, 'PartyLegalEntity', 'RegistrationAddress');
      expect(hijosElemento(direccion).map((e) => e.localName)).toEqual(['ID', 'AddressTypeCode', 'CityName', 'CountrySubentity', 'District', 'AddressLine', 'Country']);
      expect(texto(direccion, 'ID')).toBe('150119');
      expect(texto(direccion, 'AddressTypeCode')).toBe('0000');
      expect(texto(direccion, 'District')).toBe('LURIN');
      expect(texto(direccion, 'Country', 'IdentificationCode')).toBe('PE');

      const cliente = en(raiz, 'AccountingCustomerParty', 'Party', 'PartyIdentification', 'ID');
      expect(cliente.getAttribute('schemeID')).toBe('6');
      expect(cliente.textContent).toBe('20131312955');
    });

    it('no recalcula el IGV: TaxTotal y LegalMonetaryTotal son los de la entrada (8.47 + 1.53 = 10.00)', () => {
      expect(texto(raiz, 'TaxTotal', 'TaxAmount')).toBe('1.53');
      const subtotal = en(raiz, 'TaxTotal', 'TaxSubtotal');
      expect(texto(subtotal, 'TaxableAmount')).toBe('8.47');
      expect(texto(subtotal, 'TaxAmount')).toBe('1.53');
      expect(texto(subtotal, 'TaxCategory', 'ID')).toBe('S');
      expect(texto(subtotal, 'TaxCategory', 'TaxScheme', 'ID')).toBe('1000');
      const total = en(raiz, 'LegalMonetaryTotal');
      expect(hijosElemento(total).map((e) => `${e.localName}=${e.textContent}`)).toEqual([
        'LineExtensionAmount=8.47',
        'TaxInclusiveAmount=10.00',
        'PayableAmount=10.00',
      ]);
      expect(en(total, 'PayableAmount').getAttribute('currencyID')).toBe('PEN');
    });

    it('la línea declara valor unitario 8.474576, valor de venta 8.47, IGV 1.53 y precio con IGV 10.00', () => {
      const linea = en(raiz, 'InvoiceLine');
      expect(hijosElemento(linea).map((e) => e.localName)).toEqual([
        'ID', 'InvoicedQuantity', 'LineExtensionAmount', 'PricingReference', 'TaxTotal', 'Item', 'Price',
      ]);
      expect(en(linea, 'InvoicedQuantity').getAttribute('unitCode')).toBe('NIU');
      expect(texto(linea, 'InvoicedQuantity')).toBe('1');
      expect(texto(linea, 'LineExtensionAmount')).toBe('8.47');
      expect(texto(linea, 'PricingReference', 'AlternativeConditionPrice', 'PriceAmount')).toBe('10.00');
      expect(texto(linea, 'PricingReference', 'AlternativeConditionPrice', 'PriceTypeCode')).toBe('01');
      expect(texto(linea, 'TaxTotal', 'TaxAmount')).toBe('1.53');
      expect(texto(linea, 'TaxTotal', 'TaxSubtotal', 'TaxCategory', 'Percent')).toBe('18.00');
      expect(texto(linea, 'TaxTotal', 'TaxSubtotal', 'TaxCategory', 'TaxExemptionReasonCode')).toBe('10');
      expect(texto(linea, 'Item', 'SellersItemIdentification', 'ID')).toBe('P-0001');
      expect(texto(linea, 'Price', 'PriceAmount')).toBe('8.474576');
    });

    it('respeta el orden del XSD UBL 2.1 en la raíz', () => {
      expect(hijosElemento(raiz).map((e) => e.localName)).toEqual([
        'UBLExtensions', 'UBLVersionID', 'CustomizationID', 'ProfileID', 'ID', 'IssueDate', 'IssueTime', 'InvoiceTypeCode',
        'Note', 'DocumentCurrencyCode', 'Signature', 'AccountingSupplierParty', 'AccountingCustomerParty', 'PaymentTerms',
        'TaxTotal', 'LegalMonetaryTotal', 'InvoiceLine',
      ]);
      expect(texto(raiz, 'PaymentTerms', 'ID')).toBe('FormaPago');
      expect(texto(raiz, 'PaymentTerms', 'PaymentMeansID')).toBe('Contado');
      expect(raiz.getElementsByTagNameNS(CBC, 'DueDate').length).toBe(0);
    });
  });

  it('varias líneas con descuento: cac:AllowanceCharge código 00 y totales iguales a la entrada', () => {
    const doc = facturaPrueba([
      { descripcion: 'TALADRO PERCUTOR', cantidad: 2, precio: 59, descuento: 11.8 },
      { descripcion: 'BROCA 1/4', cantidad: 3, precio: 4.5 },
    ]);
    const raiz = parsear(construirXmlCpe(doc).xml).documentElement;
    const [taladro, broca] = todos(raiz, 'InvoiceLine');
    expect(hijosElemento(taladro).map((e) => e.localName)).toEqual([
      'ID', 'InvoicedQuantity', 'LineExtensionAmount', 'PricingReference', 'AllowanceCharge', 'TaxTotal', 'Item', 'Price',
    ]);
    const descuento = en(taladro, 'AllowanceCharge');
    expect(texto(descuento, 'ChargeIndicator')).toBe('false');
    expect(texto(descuento, 'AllowanceChargeReasonCode')).toBe('00');
    expect(texto(descuento, 'MultiplierFactorNumeric')).toBe('0.10');
    expect(texto(descuento, 'Amount')).toBe('10.00');
    expect(texto(descuento, 'BaseAmount')).toBe('100.00');
    expect(texto(taladro, 'LineExtensionAmount')).toBe('90.00');
    expect(texto(taladro, 'Price', 'PriceAmount')).toBe('50.00');
    expect(texto(taladro, 'PricingReference', 'AlternativeConditionPrice', 'PriceAmount')).toBe('53.10');
    expect(todos(broca, 'AllowanceCharge')).toHaveLength(0);

    expect(texto(raiz, 'LegalMonetaryTotal', 'LineExtensionAmount')).toBe(String(doc.totales.gravada.toFixed(2)));
    expect(texto(raiz, 'LegalMonetaryTotal', 'PayableAmount')).toBe(doc.totales.total.toFixed(2));
    expect(texto(raiz, 'TaxTotal', 'TaxAmount')).toBe(doc.totales.igv.toFixed(2));
    expect(doc.totales.total).toBe(119.7);
  });

  it('exonerado e inafecto: un TaxSubtotal por afectación (E/9997 y O/9998) con IGV 0', () => {
    const doc = facturaPrueba([
      { descripcion: 'LIBRO TECNICO', cantidad: 2, precio: 25, tipoIgv: 8 },
      { descripcion: 'SERVICIO DE CORTE', cantidad: 1, precio: 12, tipoIgv: 9, unidad: 'ZZ' },
    ]);
    const raiz = parsear(construirXmlCpe(doc).xml).documentElement;
    const subtotales = todos(en(raiz, 'TaxTotal'), 'TaxSubtotal');
    expect(subtotales.map((s) => [texto(s, 'TaxableAmount'), texto(s, 'TaxAmount'), texto(s, 'TaxCategory', 'ID'), texto(s, 'TaxCategory', 'TaxScheme', 'ID'), texto(s, 'TaxCategory', 'TaxScheme', 'Name')])).toEqual([
      ['50.00', '0.00', 'E', '9997', 'EXO'],
      ['12.00', '0.00', 'O', '9998', 'INA'],
    ]);
    const lineas = todos(raiz, 'InvoiceLine');
    expect(lineas.map((l) => texto(l, 'TaxTotal', 'TaxSubtotal', 'TaxCategory', 'Percent'))).toEqual(['0.00', '0.00']);
    expect(lineas.map((l) => texto(l, 'TaxTotal', 'TaxSubtotal', 'TaxCategory', 'TaxExemptionReasonCode'))).toEqual(['20', '30']);
    expect(texto(raiz, 'LegalMonetaryTotal', 'LineExtensionAmount')).toBe('62.00');
    expect(texto(raiz, 'LegalMonetaryTotal', 'PayableAmount')).toBe('62.00');
  });

  it('crédito con 2 cuotas: Credito con el pendiente, Cuota001/Cuota002 con vencimiento y DueDate de la última', () => {
    const doc = facturaPrueba([{ descripcion: 'FIERRO 1/2', cantidad: 10, precio: 35 }], {
      formaPago: {
        tipo: 'Credito',
        montoPendiente: 350,
        cuotas: [
          { numero: 1, monto: 175, fechaPago: '2026-11-12' },
          { numero: 2, monto: 175, fechaPago: '2026-12-12' },
        ],
      },
    });
    const raiz = parsear(construirXmlCpe(doc).xml).documentElement;
    expect(texto(raiz, 'DueDate')).toBe('2026-12-12');
    const terminos = todos(raiz, 'PaymentTerms').map((t) => hijosElemento(t).map((e) => `${e.localName}=${e.textContent}`));
    expect(terminos).toEqual([
      ['ID=FormaPago', 'PaymentMeansID=Credito', 'Amount=350.00'],
      ['ID=FormaPago', 'PaymentMeansID=Cuota001', 'Amount=175.00', 'PaymentDueDate=2026-11-12'],
      ['ID=FormaPago', 'PaymentMeansID=Cuota002', 'Amount=175.00', 'PaymentDueDate=2026-12-12'],
    ]);
  });

  it('código de producto SUNAT en cac:CommodityClassification (UNSPSC)', () => {
    const doc = facturaPrueba([{ descripcion: 'MARTILLO', cantidad: 1, precio: 30, codigoSunat: '27111602', codigoInterno: 'MART-01' }]);
    const item = en(parsear(construirXmlCpe(doc).xml).documentElement, 'InvoiceLine', 'Item');
    expect(hijosElemento(item).map((e) => e.localName)).toEqual(['Description', 'SellersItemIdentification', 'CommodityClassification']);
    const codigo = en(item, 'CommodityClassification', 'ItemClassificationCode');
    expect(codigo.textContent).toBe('27111602');
    expect(codigo.getAttribute('listID')).toBe('UNSPSC');
  });

  it('boleta a consumidor final: tipo 03, adquirente 0 con guion', () => {
    const { xml, nombreBase } = construirXmlCpe(boletaPrueba());
    const raiz = parsear(xml).documentElement;
    expect(nombreBase).toBe('20610206337-03-BBB1-00000026');
    expect(texto(raiz, 'InvoiceTypeCode')).toBe('03');
    const id = en(raiz, 'AccountingCustomerParty', 'Party', 'PartyIdentification', 'ID');
    expect(id.getAttribute('schemeID')).toBe('0');
    expect(id.textContent).toBe('-');
    expect(texto(raiz, 'AccountingCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName')).toBe('CLIENTES VARIOS');
  });

  it('nota de crédito: CreditNote con DiscrepancyResponse, un único BillingReference y CreditNoteLine', () => {
    const { xml, nombreBase } = construirXmlCpe(notaCreditoPrueba());
    const raiz = parsear(xml).documentElement;
    expect(raiz.localName).toBe('CreditNote');
    expect(raiz.namespaceURI).toBe(ESPACIOS_UBL.creditNote);
    expect(nombreBase).toBe('20610206337-07-FC01-00000001');
    expect(hijosElemento(raiz).map((e) => e.localName)).toEqual([
      'UBLExtensions', 'UBLVersionID', 'CustomizationID', 'ID', 'IssueDate', 'IssueTime', 'Note', 'DocumentCurrencyCode',
      'DiscrepancyResponse', 'BillingReference', 'Signature', 'AccountingSupplierParty', 'AccountingCustomerParty',
      'TaxTotal', 'LegalMonetaryTotal', 'CreditNoteLine',
    ]);
    expect(texto(raiz, 'DiscrepancyResponse', 'ReferenceID')).toBe('FFF1-00000007');
    expect(texto(raiz, 'DiscrepancyResponse', 'ResponseCode')).toBe('01');
    expect(texto(raiz, 'DiscrepancyResponse', 'Description')).toBe('ANULACION DE LA OPERACION');
    expect(todos(raiz, 'BillingReference')).toHaveLength(1);
    expect(texto(raiz, 'BillingReference', 'InvoiceDocumentReference', 'ID')).toBe('FFF1-00000007');
    expect(texto(raiz, 'BillingReference', 'InvoiceDocumentReference', 'DocumentTypeCode')).toBe('01');
    const linea = en(raiz, 'CreditNoteLine');
    expect(en(linea, 'CreditedQuantity').getAttribute('unitCode')).toBe('NIU');
    expect(texto(linea, 'PricingReference', 'AlternativeConditionPrice', 'PriceAmount')).toBe('10.00');
    expect(texto(raiz, 'LegalMonetaryTotal', 'PayableAmount')).toBe('10.00');
  });

  it('nota de crédito con descuento: sin AllowanceCharge, con valor unitario neto', () => {
    const doc = notaCreditoPrueba([{ descripcion: 'TALADRO', cantidad: 2, precio: 59, descuento: 11.8 }]);
    const linea = en(parsear(construirXmlCpe(doc).xml).documentElement, 'CreditNoteLine');
    expect(todos(linea, 'AllowanceCharge')).toHaveLength(0);
    expect(texto(linea, 'LineExtensionAmount')).toBe('90.00');
    expect(texto(linea, 'Price', 'PriceAmount')).toBe('45.00');
  });

  it('nota de crédito motivo 13: informa la nueva forma de pago', () => {
    const doc = notaCreditoPrueba(undefined, {
      referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '13', sustento: 'NUEVO CRONOGRAMA' },
      formaPago: { tipo: 'Credito', montoPendiente: 10, cuotas: [{ numero: 1, monto: 10, fechaPago: '2026-12-01' }] },
    });
    const raiz = parsear(construirXmlCpe(doc).xml).documentElement;
    expect(todos(raiz, 'PaymentTerms').map((t) => texto(t, 'PaymentMeansID'))).toEqual(['Credito', 'Cuota001']);
  });

  it('nota de débito: DebitNote con RequestedMonetaryTotal y DebitNoteLine/DebitedQuantity', () => {
    const { xml, nombreBase } = construirXmlCpe(notaDebitoPrueba());
    const raiz = parsear(xml).documentElement;
    expect(raiz.localName).toBe('DebitNote');
    expect(raiz.namespaceURI).toBe(ESPACIOS_UBL.debitNote);
    expect(nombreBase).toBe('20610206337-08-FD01-00000001');
    expect(texto(raiz, 'DiscrepancyResponse', 'ResponseCode')).toBe('02');
    expect(todos(raiz, 'LegalMonetaryTotal')).toHaveLength(0);
    expect(texto(raiz, 'RequestedMonetaryTotal', 'PayableAmount')).toBe('10.00');
    expect(texto(raiz, 'DebitNoteLine', 'DebitedQuantity')).toBe('1');
    expect(todos(raiz, 'PaymentTerms')).toHaveLength(0);
  });

  it('escapa todo el texto: razón social, descripción y sustento con & < > " \'', () => {
    const doc = facturaPrueba([{ descripcion: 'TUBO 1/2" <PVC> & CODO \'90°\'', cantidad: 1, precio: 10 }], {
      cliente: { tipoDoc: '6', numDoc: '20131312955', nombre: 'FERRETERIA "EL MARTILLO" & HNOS <SAC>' },
    });
    const xml = construirXmlCpe(doc).xml;
    const raiz = parsear(xml).documentElement;
    expect(texto(raiz, 'AccountingCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName')).toBe('FERRETERIA "EL MARTILLO" & HNOS <SAC>');
    expect(texto(raiz, 'InvoiceLine', 'Item', 'Description')).toBe('TUBO 1/2" <PVC> & CODO \'90°\'');
    expect(xml).not.toContain('<PVC>');
  });

  it('dólares: currencyID USD y leyenda en dólares', () => {
    const raiz = parsear(construirXmlCpe(facturaPrueba(undefined, { moneda: 'USD' })).xml).documentElement;
    expect(texto(raiz, 'DocumentCurrencyCode')).toBe('USD');
    expect(en(raiz, 'LegalMonetaryTotal', 'PayableAmount').getAttribute('currencyID')).toBe('USD');
    expect(texto(raiz, 'Note')).toBe('DIEZ CON 00/100 DOLARES AMERICANOS');
  });

  it('usa la leyenda recibida tal cual (importe_en_letras del comprobante)', () => {
    const raiz = parsear(construirXmlCpe(facturaPrueba(undefined, { leyendaMontoLetras: 'SON: DIEZ Y 00/100 SOLES' })).xml).documentElement;
    expect(texto(raiz, 'Note')).toBe('SON: DIEZ Y 00/100 SOLES');
  });

  it('errores de estructura: tipo no soportado, sin líneas y nota sin referencia', () => {
    expect(() => construirXmlCpe({ ...facturaPrueba(), tipo: '09' as never })).toThrow(ErrorNucleoFiscal);
    expect(() => construirXmlCpe({ ...facturaPrueba(), lineas: [] })).toThrow(DocumentoCpeInvalidoError);
    expect(() => construirXmlCpe({ ...notaCreditoPrueba(), referencia: undefined })).toThrow('comprobante que modifica');
    expect(() => new FabricaConstructoresXmlCpe().para('09' as never)).toThrow('No hay constructor UBL');
  });

  it('construirXmlCpeValidado valida antes de construir y devuelve advertencias', () => {
    const invalido: DocumentoCpe = { ...facturaPrueba(), serie: 'B001' };
    expect(() => construirXmlCpeValidado(invalido, { hoy: HOY_PRUEBA })).toThrow(DocumentoCpeInvalidoError);
    const valido = construirXmlCpeValidado(facturaPrueba(), { hoy: HOY_PRUEBA });
    expect(valido.nombreBase).toBe('20610206337-01-FFF1-00000007');
    expect(valido.advertencias).toEqual([]);
    expect(parsear(valido.xml).getElementsByTagNameNS(CAC, 'InvoiceLine').length).toBe(1);
  });
});
