import AdmZip from 'adm-zip';

export interface FacturaZipResultado {
  ok: boolean;
  fileName: string;
  zipBase64: string;
  mensaje: string;
}

export class FacturaBetaZipService {
  generarZip(xmlFirmado: string, ruc: string, tipo: string, serie: string, numero: number): FacturaZipResultado {
    // Empaqueta Factura/Boleta (<Invoice), Nota de Credito (<CreditNote),
    // Resumen Diario (<SummaryDocuments) y Guía de Remisión (<DespatchAdvice).
    if (!xmlFirmado || !/<(Invoice|CreditNote|SummaryDocuments|DespatchAdvice)[\s>]/.test(xmlFirmado)) {
      throw new Error('El XML firmado no es válido para empaquetar');
    }

    const fileName = `${ruc}-${tipo}-${serie}-${this.padNumero(numero)}.xml`;
    const zip = new AdmZip();
    zip.addFile(fileName, Buffer.from(xmlFirmado, 'utf8'));

    const zipBase64 = zip.toBuffer().toString('base64');

    return {
      ok: true,
      fileName: `${ruc}-${tipo}-${serie}-${this.padNumero(numero)}.zip`,
      zipBase64,
      mensaje: 'ZIP SUNAT preparado correctamente.',
    };
  }

  private padNumero(numero: number): string {
    return String(numero).padStart(8, '0');
  }
}
