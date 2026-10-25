import { ComprobanteEsperadoCdr, verificarCdr } from './verificar-cdr';

/**
 * CDR armados con la estructura EXACTA de los que devolvió SUNAT BETA el 15/10/2026 a los envíos
 * FB01-1, BB01-2, FB01-3 y BB01-4 (hatunsales/.tmp/sunat-beta, fuera del repo): raíz
 * ar:ApplicationResponse con xmlns por omisión de Invoice-2, ext:UBLExtensions xmlns="", firma sin
 * prefijo, IssueDate con hora, SenderParty = SUNAT, ReceiverParty = emisor, ReferenceID con ceros y
 * RecipientParty «6-<RUC>» (factura) o «6--» (boleta a consumidor final enviada con tipo 0).
 */
interface OpcionesCdr {
  referencia?: string;
  /** cac:DocumentReference/cbc:ID; por omisión igual a la referencia. null = sin DocumentReference. */
  idDocumento?: string | null;
  tipoDocumento?: string;
  codigo?: string;
  descripcion?: string;
  notas?: string[];
  /** ReceiverParty; null = sin ReceiverParty. */
  emisor?: string | null;
  /** SenderParty; null = sin SenderParty. */
  remitente?: string | null;
  /** RecipientParty; null = sin RecipientParty. */
  adquirente?: string | null;
  declaracion?: string;
}

function cdrSunat(opciones: OpcionesCdr = {}): string {
  const referencia = opciones.referencia ?? 'FB01-00000001';
  const idDocumento = opciones.idDocumento === undefined ? referencia : opciones.idDocumento;
  const parte = (nombre: string, id: string | null | undefined) =>
    id === null ? '' : `<cac:${nombre}><cac:PartyIdentification><cbc:ID>${id}</cbc:ID></cac:PartyIdentification></cac:${nombre}>`;
  const notas = (opciones.notas ?? []).map((nota) => `<cbc:Note>${nota}</cbc:Note>`).join('');
  const documento =
    idDocumento === null
      ? ''
      : `<cac:DocumentReference><cbc:ID>${idDocumento}</cbc:ID>${opciones.tipoDocumento ? `<cbc:DocumentTypeCode>${opciones.tipoDocumento}</cbc:DocumentTypeCode>` : ''}</cac:DocumentReference>`;
  return [
    opciones.declaracion ?? '<?xml version="1.0" encoding="UTF-8"?>',
    '<ar:ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:date="http://exslt.org/dates-and-times" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:regexp="http://exslt.org/regular-expressions">',
    '<ext:UBLExtensions xmlns=""><ext:UBLExtension><ext:ExtensionContent><Signature xmlns="http://www.w3.org/2000/09/xmldsig#">',
    '<SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#WithComments"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"/>',
    '<Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"/><DigestValue>WJ1FY7rxN+ieCQW2CtxIRSVR6Wt3Pq84X0l8vQ1dMs8=</DigestValue></Reference></SignedInfo>',
    '<SignatureValue>ZmlybWE=</SignatureValue><KeyInfo><X509Data><X509Certificate>Y2VydA==</X509Certificate></X509Data></KeyInfo></Signature></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>',
    '<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.0</cbc:CustomizationID><cbc:ID>1792090053739</cbc:ID>',
    '<cbc:IssueDate>2026-10-15T13:34:18</cbc:IssueDate><cbc:IssueTime>00:00:00</cbc:IssueTime><cbc:ResponseDate>2026-10-15</cbc:ResponseDate><cbc:ResponseTime>14:47:33</cbc:ResponseTime>',
    notas,
    '<cac:Signature><cbc:ID>SignSUNAT</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>SUNAT</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignSUNAT</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>',
    parte('SenderParty', opciones.remitente === undefined ? '20131312955' : opciones.remitente),
    parte('ReceiverParty', opciones.emisor === undefined ? '20614736420' : opciones.emisor),
    '<cac:DocumentResponse><cac:Response>',
    `<cbc:ReferenceID>${referencia}</cbc:ReferenceID><cbc:ResponseCode>${opciones.codigo ?? '0'}</cbc:ResponseCode>`,
    `<cbc:Description>${opciones.descripcion ?? `La Factura numero ${referencia}, ha sido aceptada`}</cbc:Description>`,
    '</cac:Response>',
    documento,
    parte('RecipientParty', opciones.adquirente === undefined ? '6-20131312955' : opciones.adquirente),
    '</cac:DocumentResponse></ar:ApplicationResponse>',
  ].join('');
}

const FACTURA: ComprobanteEsperadoCdr = {
  rucEmisor: '20614736420',
  tipo: '01',
  serie: 'FB01',
  numero: 1,
  nombreBase: '20614736420-01-FB01-00000001',
  tipoDocReceptor: '6',
  numDocReceptor: '20131312955',
};

const BOLETA: ComprobanteEsperadoCdr = {
  rucEmisor: '20614736420',
  tipo: '03',
  serie: 'BB01',
  numero: 2,
  nombreBase: '20614736420-03-BB01-00000002',
  tipoDocReceptor: '0',
  numDocReceptor: '-',
};

const cdrBoleta = (cambios: OpcionesCdr = {}) =>
  cdrSunat({ referencia: 'BB01-00000002', descripcion: 'La Boleta numero BB01-00000002, ha sido aceptada', adquirente: '6--', ...cambios });

describe('verificarCdr', () => {
  describe('constancias que corresponden al envío', () => {
    it('factura aceptada (estructura real de BETA) con el nombre R-<base>.xml', () => {
      const resultado = verificarCdr(cdrSunat(), FACTURA, 'R-20614736420-01-FB01-00000001.xml');
      expect(resultado).toEqual({
        coincide: true,
        codigo: '0',
        descripcion: 'La Factura numero FB01-00000001, ha sido aceptada',
        estado: 'ACEPTADO',
        observaciones: [],
      });
    });

    it('boleta a consumidor final: SUNAT devuelve «6--» y no se compara el adquirente', () => {
      expect(verificarCdr(cdrBoleta(), BOLETA, 'R-20614736420-03-BB01-00000002.xml')).toMatchObject({ coincide: true, estado: 'ACEPTADO' });
    });

    it('aceptada con observaciones: coincide y trae las notas separadas en código y texto', () => {
      const resultado = verificarCdr(cdrSunat({ notas: ['4031 - Debe indicar el nombre comercial', '4001-El numero de RUC del receptor no existe.'] }), FACTURA);
      expect(resultado).toMatchObject({ coincide: true, codigo: '0', estado: 'ACEPTADO_CON_OBSERVACIONES' });
      expect(resultado.observaciones).toEqual([
        { codigo: '4031', descripcion: 'Debe indicar el nombre comercial' },
        { codigo: '4001', descripcion: 'El numero de RUC del receptor no existe.' },
      ]);
    });

    it('un rechazo 2xxx del MISMO comprobante coincide: coincidir no es aceptar', () => {
      const resultado = verificarCdr(cdrSunat({ codigo: '2017', descripcion: 'El numero de documento de identidad del receptor debe ser RUC' }), FACTURA);
      expect(resultado).toMatchObject({ coincide: true, codigo: '2017', estado: 'RECHAZADO' });
      expect(resultado.motivo).toBeUndefined();
    });

    it('ceros a la izquierda en cualquiera de las dos referencias', () => {
      expect(verificarCdr(cdrSunat({ referencia: 'FB01-1' }), FACTURA).coincide).toBe(true);
      expect(verificarCdr(cdrSunat({ referencia: 'FB01-00000001', idDocumento: 'FB01-1' }), FACTURA).coincide).toBe(true);
      expect(verificarCdr(cdrSunat({ referencia: 'FB01-00000012' }), { ...FACTURA, numero: 12, nombreBase: undefined }).coincide).toBe(true);
      expect(verificarCdr(cdrSunat({ referencia: ' fb01-0001 ' }), FACTURA).coincide).toBe(true);
    });

    it('el tipo de DocumentReference, si viene, debe ser el del envío', () => {
      expect(verificarCdr(cdrSunat({ tipoDocumento: '01' }), FACTURA).coincide).toBe(true);
    });

    it('acepta el RUC del emisor con prefijo y con los papeles invertidos; el de SUNAT nunca cuenta', () => {
      expect(verificarCdr(cdrSunat({ emisor: 'R-20614736420' }), FACTURA).coincide).toBe(true);
      expect(verificarCdr(cdrSunat({ remitente: '20614736420', emisor: '20131312955' }), FACTURA).coincide).toBe(true);
      // Sin ReceiverParty solo queda SUNAT: no hay con qué comparar y deciden las demás pruebas.
      expect(verificarCdr(cdrSunat({ emisor: null }), FACTURA).coincide).toBe(true);
    });

    it('adquirente: compara solo el número porque SUNAT no respeta el tipo enviado', () => {
      const boletaDni: ComprobanteEsperadoCdr = { ...BOLETA, tipoDocReceptor: '1', numDocReceptor: '71739060' };
      expect(verificarCdr(cdrBoleta({ adquirente: '6-71739060' }), boletaDni).coincide).toBe(true);
      expect(verificarCdr(cdrBoleta({ adquirente: '1-71739060' }), boletaDni).coincide).toBe(true);
      expect(verificarCdr(cdrBoleta({ adquirente: '71739060' }), boletaDni).coincide).toBe(true);
      expect(verificarCdr(cdrBoleta({ adquirente: '-' }), boletaDni).coincide).toBe(true);
      expect(verificarCdr(cdrBoleta({ adquirente: null }), boletaDni).coincide).toBe(true);
      const extranjero: ComprobanteEsperadoCdr = { ...BOLETA, tipoDocReceptor: '7', numDocReceptor: 'ab-123456' };
      expect(verificarCdr(cdrBoleta({ adquirente: '7-AB-123456' }), extranjero).coincide).toBe(true);
    });

    it('adquirente «-» o tipo 0 en lo esperado: no se compara, diga lo que diga el CDR', () => {
      for (const adquirente of ['6--', '-', '0-00000000', '6-20100066603']) {
        expect(verificarCdr(cdrBoleta({ adquirente }), BOLETA).coincide).toBe(true);
        expect(verificarCdr(cdrBoleta({ adquirente }), { ...BOLETA, tipoDocReceptor: '1', numDocReceptor: '-' }).coincide).toBe(true);
        expect(verificarCdr(cdrBoleta({ adquirente }), { ...BOLETA, tipoDocReceptor: null, numDocReceptor: null }).coincide).toBe(true);
      }
    });

    it('nombre del archivo: tolera mayúsculas, ceros, extensión .zip y la carpeta del ZIP', () => {
      for (const nombre of [
        'R-20614736420-01-FB01-00000001.xml',
        'R-20614736420-01-FB01-00000001.zip',
        'R-20614736420-01-FB01-00000001.XML',
        'r-20614736420-01-fb01-1.xml',
        'dummy/R-20614736420-01-FB01-00000001.xml',
      ]) {
        expect(verificarCdr(cdrSunat(), FACTURA, nombre).coincide).toBe(true);
      }
    });

    it('sin nombreBase esperado no se compara el nombre del archivo', () => {
      expect(verificarCdr(cdrSunat(), { ...FACTURA, nombreBase: undefined }, 'R-otro.xml').coincide).toBe(true);
    });

    it('lee el CDR como Buffer (UTF-8, con BOM, o ISO-8859-1 si así lo declara)', () => {
      expect(verificarCdr(Buffer.from(cdrSunat(), 'utf8'), FACTURA)).toMatchObject({ coincide: true, codigo: '0' });
      expect(verificarCdr(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cdrSunat(), 'utf8')]), FACTURA).coincide).toBe(true);
      expect(verificarCdr(`${String.fromCharCode(0xfeff)}${cdrSunat()}`, FACTURA).coincide).toBe(true);

      const nota: ComprobanteEsperadoCdr = { ...FACTURA, tipo: '07', serie: 'FC01', nombreBase: '20614736420-07-FC01-00000001' };
      const latin1 = cdrSunat({
        declaracion: '<?xml version="1.0" encoding="ISO-8859-1" standalone="no"?>',
        referencia: 'FC01-00000001',
        descripcion: 'La Nota de Crédito numero FC01-00000001, ha sido aceptada',
      });
      const resultado = verificarCdr(Buffer.from(latin1, 'latin1'), nota, 'R-20614736420-07-FC01-00000001.xml');
      expect(resultado).toMatchObject({ coincide: true, descripcion: 'La Nota de Crédito numero FC01-00000001, ha sido aceptada' });
    });
  });

  describe('constancias que NO corresponden: nunca se aceptan', () => {
    it('otro número (aunque sea un CDR de aceptación)', () => {
      const resultado = verificarCdr(cdrSunat({ referencia: 'FB01-00000002' }), FACTURA);
      expect(resultado).toMatchObject({ coincide: false, codigo: '0', estado: 'ACEPTADO' });
      expect(resultado.motivo).toBe('La constancia (CDR) es del comprobante FB01-00000002 y no de FB01-1.');
    });

    it('otra serie con el mismo número', () => {
      expect(verificarCdr(cdrSunat({ referencia: 'FB02-00000001' }), FACTURA)).toMatchObject({ coincide: false });
    });

    it('las dos referencias deben coincidir (ReferenceID y DocumentReference/ID)', () => {
      const resultado = verificarCdr(cdrSunat({ referencia: 'FB01-00000001', idDocumento: 'FB01-00000009' }), FACTURA);
      expect(resultado.coincide).toBe(false);
      expect(resultado.motivo).toContain('FB01-00000009');
    });

    it('otro tipo de documento (DocumentTypeCode o nombre del archivo)', () => {
      const porTipo = verificarCdr(cdrSunat({ tipoDocumento: '03' }), FACTURA);
      expect(porTipo).toMatchObject({ coincide: false });
      expect(porTipo.motivo).toBe('La constancia (CDR) es de un documento tipo 03 y no 01.');
      const porNombre = verificarCdr(cdrSunat(), FACTURA, 'R-20614736420-03-FB01-00000001.xml');
      expect(porNombre).toMatchObject({ coincide: false });
      expect(porNombre.motivo).toContain('no corresponde a 20614736420-01-FB01-00000001');
    });

    it('otro emisor: el motivo nombra al emisor ajeno y no al RUC de SUNAT', () => {
      const resultado = verificarCdr(cdrSunat({ emisor: '20100066603' }), FACTURA);
      expect(resultado).toMatchObject({ coincide: false });
      expect(resultado.motivo).toBe('La constancia (CDR) es de otro emisor (RUC 20100066603).');
      expect(verificarCdr(cdrSunat({ emisor: 'R-20100066603' }), FACTURA).coincide).toBe(false);
      expect(verificarCdr(cdrSunat({ remitente: '20100066603', emisor: '20131312955' }), FACTURA).coincide).toBe(false);
    });

    it('otro adquirente', () => {
      const resultado = verificarCdr(cdrSunat({ adquirente: '6-20100066603' }), FACTURA);
      expect(resultado).toMatchObject({ coincide: false });
      expect(resultado.motivo).toBe('La constancia (CDR) es de otro adquirente (6-20100066603).');
      const boletaDni: ComprobanteEsperadoCdr = { ...BOLETA, tipoDocReceptor: '1', numDocReceptor: '71739060' };
      expect(verificarCdr(cdrBoleta({ adquirente: '1-45678912' }), boletaDni).coincide).toBe(false);
    });

    it('nombre de archivo de otro comprobante, de otro emisor o sin el prefijo R-', () => {
      for (const nombre of [
        'R-20614736420-01-FB01-00000002.xml',
        'R-20100066603-01-FB01-00000001.xml',
        '20614736420-01-FB01-00000001.xml',
        'constancia.xml',
      ]) {
        expect(verificarCdr(cdrSunat(), FACTURA, nombre)).toMatchObject({ coincide: false });
      }
    });

    it('CDR ilegible: vacío, basura, HTML, otra raíz o sin ResponseCode', () => {
      const casos: Array<string | Buffer> = [
        '',
        'basura',
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        '<html><body>ApplicationResponse</body></html>',
        '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>ApplicationResponse</ID></Invoice>',
        cdrSunat().replace(/<cbc:ResponseCode>0<\/cbc:ResponseCode>/, ''),
        cdrSunat().slice(0, 500),
      ];
      for (const cdr of casos) {
        const resultado = verificarCdr(cdr, FACTURA);
        expect(resultado).toMatchObject({ coincide: false, codigo: 'ERROR', motivo: 'La constancia (CDR) de SUNAT no se pudo leer.' });
      }
      expect(verificarCdr(null as unknown as string, FACTURA)).toMatchObject({ coincide: false, codigo: 'ERROR' });
    });

    it('CDR sin referencias al comprobante', () => {
      const sinReferencias = cdrSunat({ idDocumento: null }).replace('<cbc:ReferenceID>FB01-00000001</cbc:ReferenceID>', '');
      expect(verificarCdr(sinReferencias, FACTURA)).toMatchObject({
        coincide: false,
        codigo: '0',
        motivo: 'La constancia (CDR) no indica a qué comprobante responde.',
      });
    });

    it('rechaza DOCTYPE (sin expansión de entidades)', () => {
      const conDoctype = cdrSunat().replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "FB01-00000001">]>');
      expect(verificarCdr(conDoctype, FACTURA)).toMatchObject({ coincide: false, codigo: 'ERROR' });
    });
  });
});
