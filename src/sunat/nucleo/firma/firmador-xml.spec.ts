import { X509Certificate } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { construirXmlCpe } from '../construir-xml-cpe';
import { CertificadoDigitalError, FirmaDemoNoPermitidaError, FirmaXmlError, XmlInvalidoError } from '../errores-nucleo';
import { identificadorResumen } from '../identificadores-cpe';
import { CertificadoPrueba, generarCertificadoPrueba, materialDePrueba } from '../pruebas/certificados-prueba-spec';
import { facturaPrueba } from '../pruebas/documentos-prueba-spec';
import { ConstructorResumenDiarioUbl } from '../ubl/constructor-resumen-diario';
import { firmarXmlDemo } from './firma-demo';
import { ALGORITMOS_FIRMA_SUNAT, extraerDigestValue, firmarXml, verificarFirmaXml } from './firmador-xml';
import { prepararMaterialFirma, separarCertificadosPem } from './material-certificado';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const DIA = 24 * 60 * 60 * 1000;

function base64Certificado(pem: string): string {
  return new X509Certificate(pem).raw.toString('base64');
}

function capturar(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function firmasDe(xml: string): Element[] {
  const documento = new DOMParser().parseFromString(xml, 'text/xml');
  return Array.from({ length: documento.getElementsByTagNameNS(DS, 'Signature').length }, (_, i) =>
    documento.getElementsByTagNameNS(DS, 'Signature').item(i) as Element,
  );
}

describe('firmarXml (XMLDSig SUNAT con material inyectado)', () => {
  let propio: CertificadoPrueba;
  let ca: CertificadoPrueba;
  let hoja: CertificadoPrueba;
  let otro: CertificadoPrueba;
  const xmlFactura = construirXmlCpe(facturaPrueba()).xml;

  beforeAll(() => {
    propio = generarCertificadoPrueba();
    ca = generarCertificadoPrueba({ nombre: 'CA DE PRUEBAS', esCa: true, hasta: new Date(Date.now() + 3650 * DIA) });
    hoja = generarCertificadoPrueba({ emisor: ca });
    otro = generarCertificadoPrueba({ nombre: 'OTRO' });
  });

  it('firma con C14N, enveloped-signature y RSA-SHA256 dentro del único ExtensionContent, con Id="SignatureSP"', () => {
    const { xmlFirmado, digestValue, signatureValue } = firmarXml(xmlFactura, materialDePrueba(propio));
    const firmas = firmasDe(xmlFirmado);
    expect(firmas).toHaveLength(1);
    const firma = firmas[0];
    expect(firma.getAttribute('Id')).toBe('SignatureSP');
    expect(firma.prefix).toBe('ds');
    expect((firma.parentNode as Element).localName).toBe('ExtensionContent');

    const algoritmo = (nombre: string) => (firma.getElementsByTagNameNS(DS, nombre).item(0) as Element).getAttribute('Algorithm');
    expect(algoritmo('CanonicalizationMethod')).toBe(ALGORITMOS_FIRMA_SUNAT.canonicalizacion);
    expect(algoritmo('SignatureMethod')).toBe(ALGORITMOS_FIRMA_SUNAT.firma);
    expect(algoritmo('Transform')).toBe(ALGORITMOS_FIRMA_SUNAT.envuelta);
    expect(algoritmo('DigestMethod')).toBe(ALGORITMOS_FIRMA_SUNAT.digest);
    expect((firma.getElementsByTagNameNS(DS, 'Reference').item(0) as Element).getAttribute('URI')).toBe('');

    // DigestValue en base64 de un SHA-256 (32 bytes): es el "valor resumen" del QR.
    expect(Buffer.from(digestValue, 'base64')).toHaveLength(32);
    expect(digestValue).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(firma.getElementsByTagNameNS(DS, 'DigestValue').item(0)?.textContent).toBe(digestValue);
    expect(signatureValue.length).toBeGreaterThan(300);
    expect(extraerDigestValue(xmlFirmado)).toBe(digestValue);

    expect(verificarFirmaXml(xmlFirmado, propio.certificatePem)).toBe(true);
    expect(verificarFirmaXml(xmlFirmado)).toBe(true);
  });

  it('la firma es determinista para el mismo XML (reintentos = mismo hash)', () => {
    const material = materialDePrueba(propio);
    const a = firmarXml(xmlFactura, material);
    const b = firmarXml(xmlFactura, material);
    expect(b.digestValue).toBe(a.digestValue);
    expect(b.xmlFirmado).toBe(a.xmlFirmado);
  });

  it('detecta cualquier alteración posterior y un certificado distinto', () => {
    const { xmlFirmado } = firmarXml(xmlFactura, materialDePrueba(propio));
    const alterado = xmlFirmado.replace('<cbc:PayableAmount currencyID="PEN">10.00</cbc:PayableAmount>', '<cbc:PayableAmount currencyID="PEN">1.00</cbc:PayableAmount>');
    expect(alterado).not.toBe(xmlFirmado);
    expect(verificarFirmaXml(alterado, propio.certificatePem)).toBe(false);
    expect(verificarFirmaXml(xmlFirmado, otro.certificatePem)).toBe(false);
    expect(verificarFirmaXml('<no-es-xml', propio.certificatePem)).toBe(false);
  });

  it('con la cadena CA + hoja (CA primero) firma con la hoja y KeyInfo lleva SOLO la hoja', () => {
    const material = materialDePrueba(hoja, `${ca.certificatePem}${hoja.certificatePem}`, false);
    expect(separarCertificadosPem(material.certificatePem)).toHaveLength(2);
    const { xmlFirmado } = firmarXml(xmlFactura, material);
    const certificados = firmasDe(xmlFirmado)[0].getElementsByTagNameNS(DS, 'X509Certificate');
    expect(certificados.length).toBe(1);
    expect(certificados.item(0)?.textContent?.replace(/\s+/g, '')).toBe(base64Certificado(hoja.certificatePem));
    expect(verificarFirmaXml(xmlFirmado, hoja.certificatePem)).toBe(true);
    expect(prepararMaterialFirma(material).certificadoHojaPem).toBe(new X509Certificate(hoja.certificatePem).toString());
  });

  it('firma cualquier raíz UBL de SUNAT: SummaryDocuments (RC) y DespatchAdvice (GRE)', () => {
    const resumen = new ConstructorResumenDiarioUbl().construir({
      identificador: identificadorResumen('RC', '2026-10-13', 1),
      fechaGeneracion: '2026-10-13',
      fechaEmisionDocumentos: '2026-10-12',
      emisor: { ruc: '20610206337', razonSocial: 'HATUNSALES S.A.C.' },
      lineas: [
        { numeroLinea: 1, tipoDocumento: '03', serie: 'BBB1', numero: 26, tipoDocumentoCliente: '0', numeroDocumentoCliente: '-', gravada: 8.47, exonerada: 0, inafecta: 0, gratuita: 0, igv: 1.53, total: 10, estado: 1 },
      ],
    });
    const rc = firmarXml(resumen.xml, materialDePrueba(propio));
    expect(verificarFirmaXml(rc.xmlFirmado, propio.certificatePem)).toBe(true);

    const gre = `<?xml version="1.0" encoding="UTF-8"?>
<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>T001-00000001</cbc:ID>
</DespatchAdvice>`;
    const firmada = firmarXml(gre, materialDePrueba(propio));
    expect(firmasDe(firmada.xmlFirmado)).toHaveLength(1);
    expect(verificarFirmaXml(firmada.xmlFirmado, propio.certificatePem)).toBe(true);
  });

  describe('errores claros antes de firmar', () => {
    it('certificado vencido o aún no vigente (según el instante de referencia)', () => {
      const material = materialDePrueba(propio);
      const vencido = capturar(() => firmarXml(xmlFactura, material, { ahora: new Date(Date.now() + 400 * DIA) }));
      expect(vencido).toBeInstanceOf(CertificadoDigitalError);
      expect(vencido).toMatchObject({ codigo: 'FISCAL_CERT_VENCIDO' });
      const futuro = capturar(() => firmarXml(xmlFactura, material, { ahora: new Date(Date.now() - 10 * DIA) }));
      expect(futuro).toMatchObject({ codigo: 'FISCAL_CERT_NO_VIGENTE' });
    });

    it('el certificado no corresponde a la clave privada', () => {
      const cruzado = { ...materialDePrueba(propio), certificatePem: otro.certificatePem };
      expect(() => firmarXml(xmlFactura, cruzado)).toThrow('Ningún certificado del archivo corresponde a la clave privada');
    });

    it('material incompleto o clave inválida', () => {
      expect(() => firmarXml(xmlFactura, { ...materialDePrueba(propio), privateKeyPem: 'basura' })).toThrow('clave privada del certificado digital no es válida');
      expect(() => firmarXml(xmlFactura, { ...materialDePrueba(propio), certificatePem: '' })).toThrow('no contiene un certificado');
    });

    it('XML sin contenedor de firma, ya firmado, con raíz ajena o mal formado', () => {
      const material = materialDePrueba(propio);
      expect(() => firmarXml('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>', material)).toThrow(XmlInvalidoError);
      const { xmlFirmado } = firmarXml(xmlFactura, material);
      expect(() => firmarXml(xmlFirmado, material)).toThrow(FirmaXmlError);
      expect(() => firmarXml('<Pedido><ext:ExtensionContent xmlns:ext="x"/></Pedido>', material)).toThrow('no es un documento SUNAT firmable');
      expect(() => firmarXml('<Invoice><sin-cerrar></Invoice>', material)).toThrow(XmlInvalidoError);
    });
  });

  describe('firma DEMO', () => {
    it('solo fuera de producción y nunca válida', () => {
      expect(() => firmarXmlDemo(xmlFactura, { entorno: 'production' })).toThrow(FirmaDemoNoPermitidaError);
      const demo = firmarXmlDemo(xmlFactura, { entorno: 'test' });
      expect(demo.xmlFirmado).toContain('<ds:Signature Id="SignatureSP">');
      expect(demo.xmlFirmado.match(/<ext:UBLExtensions>/g)).toHaveLength(1);
      expect(verificarFirmaXml(demo.xmlFirmado, propio.certificatePem)).toBe(false);
    });
  });
});
