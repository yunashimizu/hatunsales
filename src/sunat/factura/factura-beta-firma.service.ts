import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { CertificadoDigitalService } from '../fiscal/firma-certificado.provider';
import type { MaterialFirma } from '../nucleo/documento-fiscal.types';
import { FirmaDemoNoPermitidaError, XmlInvalidoError } from '../nucleo/errores-nucleo';
import { firmarXmlDemo, MENSAJE_DEMO_EN_PRODUCCION } from '../nucleo/firma/firma-demo';
import { firmarXml } from '../nucleo/firma/firmador-xml';
import { PATRON_RAIZ_DOCUMENTO_SUNAT } from '../nucleo/ubl/espacios-ubl';

export interface FacturaFirmaResultado {
  ok: boolean;
  xmlFirmado: string;
  /** DigestValue en base64 (valor resumen del comprobante). */
  digest: string;
  signatureValue: string;
  mensaje: string;
}

export interface OpcionesFirmaBeta {
  /**
   * Solo pruebas explícitas: sin certificado, genera la firma DEMO (no válida
   * ante SUNAT). Nunca se activa por omisión y en producción lanza.
   */
  permitirDemo?: boolean;
}

const TTL_CERTIFICADO_LEGADO_MS = 10 * 60 * 1000;

/** Cache del .p12 heredado (SUNAT_CERT_PATH): evita releerlo y parsearlo en cada firma. */
let certificadoLegado: { clave: string; material: MaterialFirma; expira: number } | null = null;

function materialDesdeRutaLegada(ruta: string, password: string): MaterialFirma {
  const estado = statSync(ruta);
  const clave = createHash('sha256').update(`${ruta}\u0000${estado.mtimeMs}\u0000${estado.size}\u0000${password}`).digest('hex');
  if (certificadoLegado && certificadoLegado.clave === clave && certificadoLegado.expira > Date.now()) return certificadoLegado.material;
  const material = new CertificadoDigitalService().materialDesdeBuffer(readFileSync(ruta), password);
  certificadoLegado = { clave, material, expira: Date.now() + TTL_CERTIFICADO_LEGADO_MS };
  return material;
}

/**
 * Firma el XML UBL antes de enviarlo a SUNAT. Sirve para cualquier raíz:
 * Invoice, CreditNote, DebitNote, SummaryDocuments, VoidedDocuments y DespatchAdvice.
 *  1. Con `material` (certificado del panel, descifrado en memoria): firma XMLDSig real.
 *  2. Sin material, con SUNAT_CERT_PATH + SUNAT_CERT_PASSWORD (ruta heredada): firma real.
 *  3. Sin certificado: lanza FirmaDemoNoPermitidaError. La firma DEMO solo se
 *     genera con { permitirDemo: true } fuera de producción (pruebas explícitas).
 */
export class FacturaBetaFirmaService {
  async firmar(xml: string, material?: MaterialFirma | null, opciones: OpcionesFirmaBeta = {}): Promise<FacturaFirmaResultado> {
    if (!xml || !PATRON_RAIZ_DOCUMENTO_SUNAT.test(xml)) {
      throw new XmlInvalidoError('El XML no es válido para firmar');
    }

    if (material) {
      return this.resultadoReal(firmarXml(xml, material), 'XML firmado con el certificado digital del panel (XML-DSig, RSA-SHA256).');
    }

    const certPath = process.env.SUNAT_CERT_PATH;
    const certPassword = process.env.SUNAT_CERT_PASSWORD;
    if (certPath && certPassword && existsSync(certPath)) {
      const legado = materialDesdeRutaLegada(certPath, certPassword);
      return this.resultadoReal(firmarXml(xml, legado), 'XML firmado con certificado digital real (XML-DSig, RSA-SHA256).');
    }

    if (process.env.NODE_ENV === 'production') {
      throw new FirmaDemoNoPermitidaError(MENSAJE_DEMO_EN_PRODUCCION);
    }
    if (!opciones.permitirDemo) {
      throw new FirmaDemoNoPermitidaError(
        'No hay certificado digital para firmar: cargue el certificado en Panel → Facturación SUNAT (la firma DEMO solo se usa en pruebas explícitas).',
      );
    }
    const demo = firmarXmlDemo(xml);
    return {
      ok: true,
      xmlFirmado: demo.xmlFirmado,
      digest: demo.digestValue,
      signatureValue: demo.signatureValue,
      mensaje: 'XML firmado en modo DEMO (sin certificado real): no es válido ante SUNAT.',
    };
  }

  private resultadoReal(resultado: { xmlFirmado: string; digestValue: string; signatureValue: string }, mensaje: string): FacturaFirmaResultado {
    return { ok: true, xmlFirmado: resultado.xmlFirmado, digest: resultado.digestValue, signatureValue: resultado.signatureValue, mensaje };
  }
}
