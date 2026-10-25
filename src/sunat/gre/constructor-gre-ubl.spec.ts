import { descendientes, hijos, nombreLocal, parsearXml, primerDescendiente, ruta, texto } from '../nucleo/xml/lector-xml';
import { ConstructorGreUbl, ESPACIO_DESPATCH_ADVICE, nombreBaseGre } from './constructor-gre-ubl';
import { greOtrosPrivado, greTrasladoPrivado, greVentaPublica } from './pruebas/documentos-gre-prueba-spec';

/**
 * Orden de los hijos según el XSD UBL 2.1 de OASIS (subconjunto de lo que emite el constructor, en el mismo
 * orden que las secuencias de UBL-DespatchAdvice-2.1.xsd y UBL-CommonAggregateComponents-2.1.xsd). La
 * validación completa contra el XSD se hace con las muestras firmadas (scratchpad/ref/xml-gre).
 */
const ORDEN_XSD: Readonly<Record<string, readonly string[]>> = {
  DespatchAdvice: [
    'UBLExtensions', 'UBLVersionID', 'CustomizationID', 'ID', 'IssueDate', 'IssueTime', 'DespatchAdviceTypeCode', 'Note',
    'AdditionalDocumentReference', 'Signature', 'DespatchSupplierParty', 'DeliveryCustomerParty', 'Shipment', 'DespatchLine',
  ],
  AdditionalDocumentReference: ['ID', 'DocumentTypeCode', 'DocumentType', 'IssuerParty'],
  Signature: ['ID', 'SignatoryParty', 'DigitalSignatureAttachment'],
  Party: ['PartyIdentification', 'PartyName', 'PartyLegalEntity'],
  PartyLegalEntity: ['RegistrationName', 'CompanyID'],
  Shipment: ['ID', 'HandlingCode', 'HandlingInstructions', 'GrossWeightMeasure', 'TotalTransportHandlingUnitQuantity', 'ShipmentStage', 'Delivery', 'TransportHandlingUnit'],
  ShipmentStage: ['TransportModeCode', 'TransitPeriod', 'CarrierParty', 'LoadingTransportEvent', 'DriverPerson'],
  DriverPerson: ['ID', 'FirstName', 'FamilyName', 'JobTitle', 'IdentityDocumentReference'],
  Delivery: ['DeliveryAddress', 'Despatch'],
  DeliveryAddress: ['ID', 'AddressTypeCode', 'AddressLine'],
  DespatchAddress: ['ID', 'AddressTypeCode', 'AddressLine'],
  TransportHandlingUnit: ['TransportEquipment'],
  TransportEquipment: ['ID', 'ApplicableTransportMeans'],
  DespatchLine: ['ID', 'DeliveredQuantity', 'OrderLineReference', 'Item'],
  Item: ['Description', 'SellersItemIdentification', 'CommodityClassification'],
};

/** Lista los elementos cuyos hijos no siguen el orden del XSD (o traen hijos que no deberían). */
function violacionesDeOrden(xml: string): string[] {
  const documento = parsearXml(xml);
  const problemas: string[] = [];
  const revisar = (elemento: Element) => {
    const orden = ORDEN_XSD[nombreLocal(elemento)];
    if (orden) {
      let anterior = -1;
      for (const hijo of hijos(elemento)) {
        const posicion = orden.indexOf(nombreLocal(hijo));
        if (posicion < 0) problemas.push(`${nombreLocal(elemento)} no admite ${nombreLocal(hijo)}`);
        else if (posicion < anterior) problemas.push(`${nombreLocal(elemento)}: ${nombreLocal(hijo)} fuera de orden`);
        anterior = Math.max(anterior, posicion);
      }
    }
    hijos(elemento).forEach(revisar);
  };
  revisar(documento.documentElement);
  return problemas;
}

const constructor = new ConstructorGreUbl();

describe('ConstructorGreUbl', () => {
  it('venta con transporte público: cabecera, partes, transportista, fechas y documento relacionado', () => {
    const { xml, nombreBase } = constructor.construir(greVentaPublica());
    expect(nombreBase).toBe('20610206337-09-T001-00000001');
    expect(violacionesDeOrden(xml)).toEqual([]);

    const doc = parsearXml(xml);
    const raiz = doc.documentElement;
    expect(nombreLocal(raiz)).toBe('DespatchAdvice');
    expect(raiz.namespaceURI).toBe(ESPACIO_DESPATCH_ADVICE);
    expect(texto(hijos(raiz, 'UBLVersionID')[0])).toBe('2.1');
    expect(texto(hijos(raiz, 'CustomizationID')[0])).toBe('2.0');
    expect(texto(hijos(raiz, 'ID')[0])).toBe('T001-00000001');
    expect(texto(hijos(raiz, 'IssueTime')[0])).toBe('10:15:30');
    const tipo = hijos(raiz, 'DespatchAdviceTypeCode')[0];
    expect(texto(tipo)).toBe('09');
    expect(tipo.getAttribute('listURI')).toBe('urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01');

    // Un único ExtensionContent vacío para la firma.
    const extensiones = descendientes(doc, 'ExtensionContent');
    expect(extensiones).toHaveLength(1);
    expect(hijos(extensiones[0])).toHaveLength(0);

    const relacionado = hijos(raiz, 'AdditionalDocumentReference')[0];
    expect(texto(hijos(relacionado, 'ID')[0])).toBe('F001-125');
    expect(texto(hijos(relacionado, 'DocumentTypeCode')[0])).toBe('01');
    expect(hijos(relacionado, 'DocumentTypeCode')[0].getAttribute('listURI')).toBe('urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61');
    expect(texto(hijos(relacionado, 'DocumentType')[0])).toBe('Factura');
    expect(texto(ruta(relacionado, 'IssuerParty', 'PartyIdentification', 'ID'))).toBe('20610206337');

    const remitente = ruta(doc, 'DespatchSupplierParty', 'Party', 'PartyIdentification', 'ID')!;
    expect(texto(remitente)).toBe('20610206337');
    expect(remitente.getAttribute('schemeID')).toBe('6');
    expect(remitente.getAttribute('schemeURI')).toBe('urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06');
    expect(texto(ruta(doc, 'DeliveryCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName'))).toBe('CONSTRUCTORA LOS ANDES S.A.C.');

    const envio = primerDescendiente(doc, 'Shipment')!;
    expect(texto(hijos(envio, 'ID')[0])).toBe('SUNAT_Envio');
    const motivo = hijos(envio, 'HandlingCode')[0];
    expect(texto(motivo)).toBe('01');
    expect(motivo.getAttribute('listURI')).toBe('urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20');
    const peso = hijos(envio, 'GrossWeightMeasure')[0];
    expect(texto(peso)).toBe('1250.500');
    expect(peso.getAttribute('unitCode')).toBe('KGM');
    expect(texto(hijos(envio, 'TotalTransportHandlingUnitQuantity')[0])).toBe('25');

    const etapa = hijos(envio, 'ShipmentStage')[0];
    expect(texto(hijos(etapa, 'TransportModeCode')[0])).toBe('01');
    expect(texto(ruta(etapa, 'TransitPeriod', 'StartDate'))).toBe('2026-10-21');
    expect(texto(ruta(etapa, 'LoadingTransportEvent', 'OccurrenceDate'))).toBe('2026-10-21');
    expect(texto(ruta(etapa, 'CarrierParty', 'PartyIdentification', 'ID'))).toBe('20100066603');
    expect(texto(ruta(etapa, 'CarrierParty', 'PartyLegalEntity', 'CompanyID'))).toBe('1534567CNG');
    expect(hijos(etapa, 'DriverPerson')).toHaveLength(0);
    expect(hijos(envio, 'TransportHandlingUnit')).toHaveLength(0);

    // Con motivo 01 no viaja el código de establecimiento (no es obligatorio).
    expect(descendientes(doc, 'AddressTypeCode')).toHaveLength(0);
    expect(texto(ruta(envio, 'Delivery', 'DeliveryAddress', 'ID'))).toBe('150122');
    expect(texto(ruta(envio, 'Delivery', 'Despatch', 'DespatchAddress', 'ID'))).toBe('150119');
    expect(ruta(envio, 'Delivery', 'DeliveryAddress', 'ID')!.getAttribute('schemeAgencyName')).toBe('PE:INEI');

    const linea = primerDescendiente(doc, 'DespatchLine')!;
    expect(texto(hijos(linea, 'ID')[0])).toBe('1');
    expect(texto(ruta(linea, 'OrderLineReference', 'LineID'))).toBe('1');
    const cantidad = hijos(linea, 'DeliveredQuantity')[0];
    expect(texto(cantidad)).toBe('25');
    expect(cantidad.getAttribute('unitCode')).toBe('BG');
    expect(texto(ruta(linea, 'Item', 'CommodityClassification', 'ItemClassificationCode'))).toBe('30111601');
  });

  it('la fecha de entrega al transportista, si llega, va en LoadingTransportEvent', () => {
    const { xml } = constructor.construir(greVentaPublica({ envio: { fechaInicioTraslado: '2026-10-23', fechaEntregaTransportista: '2026-10-22' } }));
    const etapa = primerDescendiente(parsearXml(xml), 'ShipmentStage')!;
    expect(texto(ruta(etapa, 'TransitPeriod', 'StartDate'))).toBe('2026-10-23');
    expect(texto(ruta(etapa, 'LoadingTransportEvent', 'OccurrenceDate'))).toBe('2026-10-22');
  });

  it('traslado 04 con transporte privado: establecimientos, vehículo, conductores y varios ítems', () => {
    const { xml, nombreBase } = constructor.construir(greTrasladoPrivado());
    expect(nombreBase).toBe('20610206337-09-T001-00000002');
    expect(violacionesDeOrden(xml)).toEqual([]);
    const doc = parsearXml(xml);
    const envio = primerDescendiente(doc, 'Shipment')!;
    expect(texto(hijos(envio, 'HandlingCode')[0])).toBe('04');
    expect(texto(hijos(envio, 'GrossWeightMeasure')[0])).toBe('0.750');
    expect(hijos(envio, 'GrossWeightMeasure')[0].getAttribute('unitCode')).toBe('TNE');
    expect(hijos(envio, 'TotalTransportHandlingUnitQuantity')).toHaveLength(0);

    const etapa = hijos(envio, 'ShipmentStage')[0];
    expect(texto(hijos(etapa, 'TransportModeCode')[0])).toBe('02');
    expect(texto(ruta(etapa, 'TransitPeriod', 'StartDate'))).toBe('2026-10-22');
    expect(hijos(etapa, 'CarrierParty')).toHaveLength(0);
    expect(hijos(etapa, 'LoadingTransportEvent')).toHaveLength(0);
    const conductores = hijos(etapa, 'DriverPerson');
    expect(conductores.map((c) => texto(hijos(c, 'JobTitle')[0]))).toEqual(['Principal', 'Secundario']);
    expect(texto(hijos(conductores[0], 'ID')[0])).toBe('45678912');
    expect(hijos(conductores[0], 'ID')[0].getAttribute('schemeID')).toBe('1');
    expect(texto(hijos(conductores[0], 'FirstName')[0])).toBe('JUAN CARLOS');
    expect(texto(hijos(conductores[0], 'FamilyName')[0])).toBe('PEREZ QUISPE');
    expect(texto(ruta(conductores[0], 'IdentityDocumentReference', 'ID'))).toBe('Q45678912');

    const equipo = ruta(envio, 'TransportHandlingUnit', 'TransportEquipment')!;
    expect(texto(hijos(equipo, 'ID')[0])).toBe('ABC123');
    expect(texto(ruta(equipo, 'ApplicableTransportMeans', 'RegistrationNationalityID'))).toBe('15M21012345');

    const llegada = ruta(envio, 'Delivery', 'DeliveryAddress', 'AddressTypeCode')!;
    expect(texto(llegada)).toBe('0001');
    expect(llegada.getAttribute('listID')).toBe('20610206337');
    expect(llegada.getAttribute('listName')).toBe('Establecimientos anexos');
    expect(texto(ruta(envio, 'Delivery', 'Despatch', 'DespatchAddress', 'AddressTypeCode'))).toBe('0000');

    const lineas = descendientes(doc, 'DespatchLine');
    expect(lineas.map((l) => texto(hijos(l, 'ID')[0]))).toEqual(['1', '2', '3']);
    expect(lineas.map((l) => texto(hijos(l, 'DeliveredQuantity')[0]))).toEqual(['10', '2.5', '40']);
    expect(hijos(lineas[1], 'DeliveredQuantity')[0].getAttribute('unitCodeListID')).toBe('UN/ECE rec 20');
    expect(texto(ruta(lineas[0], 'Item', 'SellersItemIdentification', 'ID'))).toBe('HER-010');
    expect(ruta(lineas[1], 'Item', 'SellersItemIdentification')).toBeNull();
    // Sin documentos relacionados no se emite AdditionalDocumentReference.
    expect(descendientes(doc, 'AdditionalDocumentReference')).toHaveLength(0);
  });

  it('otros (13): descripción del motivo, observaciones y caracteres especiales escapados', () => {
    const original = greOtrosPrivado();
    const { xml } = constructor.construir(original);
    expect(violacionesDeOrden(xml)).toEqual([]);
    expect(xml).not.toMatch(/<TALLER>|& |"KIT"/);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;SERIE 12-AB&gt;');

    const doc = parsearXml(xml);
    expect(texto(primerDescendiente(doc, 'HandlingInstructions'))).toBe('TRASLADO A REPARACIÓN DE EQUIPO');
    expect(texto(hijos(doc.documentElement, 'Note')[0])).toBe(original.observaciones);
    expect(texto(ruta(doc, 'DeliveryCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName'))).toBe(original.destinatario.nombre);
    expect(texto(ruta(doc, 'DespatchLine', 'Item', 'Description'))).toBe(original.items[0].descripcion);
    expect(texto(ruta(doc, 'DeliveryAddress', 'AddressLine', 'Line'))).toBe(original.envio.llegada.direccion);
    expect(texto(ruta(doc, 'DriverPerson', 'FamilyName'))).toBe("D'ANGELO ÑAHUI");
  });

  it('el número del documento relacionado va sin ceros a la izquierda y la DAM sin IssuerParty', () => {
    const { xml } = constructor.construir(
      greVentaPublica({
        documentosRelacionados: [
          { tipo: '03', serie: 'b001', numero: '00000077', rucEmisor: '20553856451' },
          { tipo: '50', serie: '', numero: '118-2026-10-123456' },
        ],
      }),
    );
    const [boleta, dam] = descendientes(parsearXml(xml), 'AdditionalDocumentReference');
    expect(texto(hijos(boleta, 'ID')[0])).toBe('B001-77');
    expect(texto(ruta(boleta, 'IssuerParty', 'PartyIdentification', 'ID'))).toBe('20553856451');
    expect(texto(hijos(dam, 'ID')[0])).toBe('118-2026-10-123456');
    expect(texto(hijos(dam, 'DocumentType')[0])).toBe('Declaración Aduanera de Mercancías (DAM)');
    expect(hijos(dam, 'IssuerParty')).toHaveLength(0);
  });

  it('nombreBaseGre sigue RUC-09-SERIE-NNNNNNNN', () => {
    expect(nombreBaseGre('20610206337', 'T001', 12)).toBe('20610206337-09-T001-00000012');
  });
});
