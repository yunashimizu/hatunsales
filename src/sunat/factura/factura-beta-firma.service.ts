import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { CertificadoDigitalService, FirmadorXmlCertificado } from '../fiscal/firma-certificado.provider';

export interface FacturaFirmaResultado {
  ok: boolean;
  xmlFirmado: string;
  digest: string;
  signatureValue: string;
  mensaje: string;
}

/**
 * Firma el XML UBL antes de enviarlo a SUNAT.
 *
 * Si SUNAT_CERT_PATH + SUNAT_CERT_PASSWORD estan configurados (el CDT
 * gratuito de SUNAT+RENIEC, o un certificado comercial de un PSC acreditado
 * ante INDECOPI), firma de verdad con FirmadorXmlCertificado: XML-DSig real,
 * verificable, con la clave privada del certificado.
 *
 * Sin esas variables (el comportamiento por defecto hoy, mientras no se
 * tenga el certificado) sigue en modo DEMO: no hay clave privada real, el
 * "digest"/"signatureValue" no son una firma valida ante SUNAT — solo sirven
 * para probar el resto del flujo (armado de XML, ZIP, envio) antes de tener
 * el certificado. No usar el modo DEMO contra el ambiente de produccion.
 */
export class FacturaBetaFirmaService {
  async firmar(xml: string): Promise<FacturaFirmaResultado> {
    // Firma XML generico: se usa para Factura/Boleta (<Invoice), Nota de
    // Credito (<CreditNote), Resumen Diario (<SummaryDocuments) y Guía de
    // Remisión (<DespatchAdvice) — no solo para Invoice, aunque el archivo
    // se llame "factura-beta-firma" por historia.
    if (!xml || !/<(Invoice|CreditNote|SummaryDocuments|DespatchAdvice)[\s>]/.test(xml)) {
      throw new Error('El XML no es válido para firmar');
    }

    const certPath = process.env.SUNAT_CERT_PATH;
    const certPassword = process.env.SUNAT_CERT_PASSWORD;

    if (certPath && certPassword && existsSync(certPath)) {
      return this.firmarConCertificadoReal(xml, certPath, certPassword);
    }

    return this.firmarDemo(xml);
  }

  private firmarConCertificadoReal(xml: string, certPath: string, certPassword: string): FacturaFirmaResultado {
    const certificado = new CertificadoDigitalService().cargarDesdeArchivo(certPath, certPassword);
    const resultado = new FirmadorXmlCertificado(certificado).firmar(xml);

    return {
      ok: true,
      xmlFirmado: resultado.xmlFirmado,
      digest: resultado.digest,
      signatureValue: resultado.signatureValue,
      mensaje: 'XML firmado con certificado digital real (XML-DSig, RSA-SHA256).',
    };
  }

  /** Firma DEMO: hash local sin clave privada. Solo para probar el flujo mientras no hay certificado. */
  private firmarDemo(xml: string): FacturaFirmaResultado {
    const digest = createHash('sha256').update(xml, 'utf8').digest('hex');
    const signatureValue = `signature-${digest.slice(0, 32)}`;
    const firmaXml = `
        <ds:Signature>
          <ds:SignedInfo>
            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
            <ds:Reference URI="">
              <ds:Transforms>
                <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
              </ds:Transforms>
              <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
              <ds:DigestValue>${digest}</ds:DigestValue>
            </ds:Reference>
          </ds:SignedInfo>
          <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
          <ds:KeyInfo>
            <ds:X509Data>
              <ds:X509Certificate>MI_CERTIFICADO_DEMO</ds:X509Certificate>
            </ds:X509Data>
          </ds:KeyInfo>
        </ds:Signature>`;

    // Si el XML ya trae el slot vacio que deja InvoiceUblBuilder, se llena ahi
    // (un solo ext:UBLExtensions, sin duplicar). Si no (XML de prueba suelto,
    // sin ese slot), se cae al comportamiento anterior: agregar el bloque
    // completo antes de </Invoice>.
    const xmlFirmado = xml.includes('<ext:ExtensionContent/>')
      ? xml.replace('<ext:ExtensionContent/>', `<ext:ExtensionContent>${firmaXml}</ext:ExtensionContent>`)
      : xml.replace(
          '</Invoice>',
          `
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>${firmaXml}</ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
</Invoice>`,
        );

    return {
      ok: true,
      xmlFirmado,
      digest,
      signatureValue,
      mensaje: 'XML firmado en modo DEMO (sin certificado real todavía): no enviar así al ambiente de producción de SUNAT.',
    };
  }
}
