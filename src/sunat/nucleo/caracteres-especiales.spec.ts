import { DOMParser } from '@xmldom/xmldom';
import type { DocumentoCpe } from './documento-fiscal.types';
import { verificarFirmaXml } from './firma/firmador-xml';
import { PreparadorEnvioCpe } from './preparador-envio-cpe';
import { CertificadoPrueba, generarCertificadoPrueba, materialDePrueba } from './pruebas/certificados-prueba-spec';
import { EMISOR_PRUEBA, facturaPrueba, HOY_PRUEBA, notaCreditoPrueba, RUC_CLIENTE_PRUEBA } from './pruebas/documentos-prueba-spec';
import { escaparXml, limpiarTextoXml } from './xml/escritor-xml';
import { descendientes, hijos, ruta, texto } from './xml/lector-xml';
import { leerXmlDeZip } from './zip/paquete-zip';

/**
 * Textos reales de una ferretería: eñe, tildes, diéresis, pulgadas (1/2"), «&», «<», «>» y «]]>»
 * en razón social, nombre comercial, direcciones, descripciones y sustento. Se construye el XML
 * con el builder real, se firma con un certificado de prueba y se comprueba el escape, que el
 * texto vuelve idéntico al leerlo y que la firma sigue verificando (también después del ZIP).
 */
const RAZON_SOCIAL = 'FERRETERÍA ÑANDÚ & HNOS. "EL MARTILLO" <S.A.C.>';
const NOMBRE_COMERCIAL = "ÑANDÚ & CÍA 'LA LLAVE'";
const DIRECCION_EMISOR = 'AV. JOSÉ GÁLVEZ N° 123 <INT. B> & ÁNCASH';
const CLIENTE = 'PEÑA & ASOCIADOS "LOS ÁLAMOS" <E.I.R.L.>';
const DIRECCION_CLIENTE = 'JR. ÑUÑOA 456 – "A" & <B> PINGÜINO';
const DESCRIPCION_TUBO = 'TUBO PVC 1/2" ÑANDÚ & CODO <90°> ]]> FIN';
const DESCRIPCION_LLAVE = "LLAVE FRANCESA 12\" CROMO-VANADIO ÁÉÍÓÚ ü 'PRO'";
const SUSTENTO = 'DEVOLUCIÓN POR "FALLA" & <DAÑO> EN TUBO 1/2"';

function documentoConCaracteresEspeciales(): DocumentoCpe {
  return facturaPrueba(
    [
      { descripcion: DESCRIPCION_TUBO, cantidad: 2, precio: 12.5, codigoInterno: 'TUBO-1/2"' },
      { descripcion: DESCRIPCION_LLAVE, cantidad: 1, precio: 45.9 },
    ],
    {
      emisor: { ...EMISOR_PRUEBA, razonSocial: RAZON_SOCIAL, nombreComercial: NOMBRE_COMERCIAL, direccion: DIRECCION_EMISOR },
      cliente: { tipoDoc: '6', numDoc: RUC_CLIENTE_PRUEBA, nombre: CLIENTE, direccion: DIRECCION_CLIENTE },
    },
  );
}

function parsear(xml: string): Document {
  const errores: string[] = [];
  const documento = new DOMParser({
    errorHandler: { warning: () => undefined, error: (m) => errores.push(String(m)), fatalError: (m) => errores.push(String(m)) },
  }).parseFromString(xml, 'text/xml');
  expect(errores).toEqual([]);
  return documento;
}

describe('caracteres especiales en el XML firmado (eñe, tildes, pulgadas, &, <, >)', () => {
  let certificado: CertificadoPrueba;

  beforeAll(() => {
    certificado = generarCertificadoPrueba();
  });

  function preparar(doc: DocumentoCpe) {
    return new PreparadorEnvioCpe().prepararComprobante(doc, materialDePrueba(certificado), { hoy: HOY_PRUEBA });
  }

  it('el builder escapa &, <, >, comillas y apóstrofos y deja las letras en UTF-8 (sin referencias numéricas)', () => {
    const { xmlSinFirmar } = preparar(documentoConCaracteresEspeciales());
    expect(xmlSinFirmar).toContain('FERRETERÍA ÑANDÚ &amp; HNOS. &quot;EL MARTILLO&quot; &lt;S.A.C.&gt;');
    expect(xmlSinFirmar).toContain('TUBO PVC 1/2&quot; ÑANDÚ &amp; CODO &lt;90°&gt; ]]&gt; FIN');
    expect(xmlSinFirmar).toContain('ÑANDÚ &amp; CÍA &apos;LA LLAVE&apos;');
    expect(xmlSinFirmar).not.toContain('<S.A.C.>');
    expect(xmlSinFirmar).not.toContain('<90°>');
    expect(xmlSinFirmar).not.toContain(']]>');
    expect(xmlSinFirmar).not.toMatch(/&#\d+;|&#x[0-9a-f]+;/i);
  });

  it('firmado: el texto vuelve idéntico en cada campo y la firma verifica', () => {
    const preparado = preparar(documentoConCaracteresEspeciales());
    const { xmlFirmado } = preparado;
    const raiz = parsear(xmlFirmado).documentElement;

    const proveedor = ruta(raiz, 'AccountingSupplierParty', 'Party')!;
    expect(texto(ruta(proveedor, 'PartyLegalEntity', 'RegistrationName'))).toBe(RAZON_SOCIAL);
    expect(texto(ruta(proveedor, 'PartyName', 'Name'))).toBe(NOMBRE_COMERCIAL);
    expect(texto(ruta(proveedor, 'RegistrationAddress', 'AddressLine', 'Line'))).toBe(DIRECCION_EMISOR);
    expect(texto(ruta(raiz, 'SignatoryParty', 'PartyName', 'Name'))).toBe(RAZON_SOCIAL);

    const cliente = ruta(raiz, 'AccountingCustomerParty', 'Party')!;
    expect(texto(ruta(cliente, 'PartyLegalEntity', 'RegistrationName'))).toBe(CLIENTE);
    expect(texto(ruta(cliente, 'RegistrationAddress', 'AddressLine', 'Line'))).toBe(DIRECCION_CLIENTE);

    const lineas = hijos(raiz, 'InvoiceLine');
    expect(lineas.map((linea) => texto(ruta(linea, 'Item', 'Description')))).toEqual([DESCRIPCION_TUBO, DESCRIPCION_LLAVE]);
    expect(texto(ruta(lineas[0], 'SellersItemIdentification', 'ID'))).toBe('TUBO-1/2"');

    // La firma (xml-crypto) re-serializa con xmldom: «>» sigue escapado, así que «]]>» nunca queda suelto.
    expect(xmlFirmado).not.toContain('<S.A.C.>');
    expect(xmlFirmado).not.toContain(']]>');
    expect(xmlFirmado).toContain('ÑANDÚ');
    expect(descendientes(raiz, 'Signature').filter((firma) => firma.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#')).toHaveLength(1);
    expect(verificarFirmaXml(xmlFirmado, certificado.certificatePem)).toBe(true);
    expect(preparado.advertencias).toEqual([]);
  });

  it('el ZIP guarda el XML firmado en UTF-8 sin cambiar un byte y la firma sigue verificando', () => {
    const { xmlFirmado, zip } = preparar(documentoConCaracteresEspeciales());
    const leido = leerXmlDeZip(zip.zip);
    expect(leido?.nombre).toBe(zip.nombreXml);
    expect(leido?.xml).toBe(xmlFirmado);
    expect(Buffer.from(xmlFirmado, 'utf8').includes(Buffer.from('Ñ', 'utf8'))).toBe(true);
    expect(verificarFirmaXml(leido!.xml, certificado.certificatePem)).toBe(true);
  });

  it('cambiar una tilde o una eñe después de firmar rompe la firma (el digest cubre esos bytes)', () => {
    const { xmlFirmado } = preparar(documentoConCaracteresEspeciales());
    expect(verificarFirmaXml(xmlFirmado.replace('PINGÜINO', 'PINGUINO'), certificado.certificatePem)).toBe(false);
    expect(verificarFirmaXml(xmlFirmado.replace('ÑUÑOA', 'NUNOA'), certificado.certificatePem)).toBe(false);
  });

  it('nota de crédito: el sustento con comillas, & y < viaja escapado y firmado', () => {
    const nota = notaCreditoPrueba([{ descripcion: DESCRIPCION_TUBO, cantidad: 1, precio: 12.5 }], {
      cliente: { tipoDoc: '6', numDoc: RUC_CLIENTE_PRUEBA, nombre: CLIENTE, direccion: DIRECCION_CLIENTE },
      referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '07', sustento: SUSTENTO },
    });
    const { xmlSinFirmar, xmlFirmado } = preparar(nota);
    expect(xmlSinFirmar).toContain('DEVOLUCIÓN POR &quot;FALLA&quot; &amp; &lt;DAÑO&gt; EN TUBO 1/2&quot;');
    const raiz = parsear(xmlFirmado).documentElement;
    expect(texto(ruta(raiz, 'DiscrepancyResponse', 'Description'))).toBe(SUSTENTO);
    expect(texto(ruta(raiz, 'CreditNoteLine', 'Item', 'Description'))).toBe(DESCRIPCION_TUBO);
    expect(verificarFirmaXml(xmlFirmado, certificado.certificatePem)).toBe(true);
  });

  it('escaparXml y limpiarTextoXml: escape completo y sin caracteres prohibidos por XML 1.0', () => {
    expect(escaparXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(escaparXml('ÑANDÚ 1/2" ]]>')).toBe('ÑANDÚ 1/2&quot; ]]&gt;');
    expect(escaparXml('&amp;')).toBe('&amp;amp;');
    expect(limpiarTextoXml(`A\u0000B\u0007C\u000BD\tE\r\nF\rG${String.fromCharCode(0xfffe)}H`)).toBe('ABCD\tE\nF\nGH');
    expect(limpiarTextoXml('emoji 🔧 ok')).toBe('emoji 🔧 ok');
    expect(limpiarTextoXml('suelto \uD83D fin')).toBe('suelto  fin');
  });
});
