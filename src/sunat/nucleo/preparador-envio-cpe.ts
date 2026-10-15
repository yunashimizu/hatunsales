import { construirCadenaQr } from './cadena-qr';
import { FabricaConstructoresXmlCpe } from './construir-xml-cpe';
import type { DocumentoCpe, MaterialFirma, OpcionesValidacionCpe, PaqueteZip } from './documento-fiscal.types';
import { extraerDigestValue, FirmadorXmlSunat, OpcionesFirmaXml } from './firma/firmador-xml';
import { ConstructorComunicacionBajaUbl, DatosComunicacionBaja } from './ubl/constructor-comunicacion-baja';
import { ConstructorResumenDiarioUbl, DatosResumenDiario } from './ubl/constructor-resumen-diario';
import { ValidadorDocumentoCpe } from './validaciones-cpe';
import { empaquetarZip } from './zip/paquete-zip';

export type OpcionesPreparacionCpe = OpcionesValidacionCpe & OpcionesFirmaXml;

/** Todo lo que se guarda antes de enviar un comprobante (el XML firmado se envía tal cual en cada reintento). */
export interface EnvioCpePreparado {
  nombreBase: string;
  xmlSinFirmar: string;
  xmlFirmado: string;
  /** Valor resumen (DigestValue base64): va en comprobantes.codigo_hash y en el QR. */
  digestValue: string;
  signatureValue: string;
  zip: PaqueteZip;
  cadenaQr: string;
  advertencias: string[];
}

/** Resumen diario (RC) o comunicación de baja (RA) listo para sendSummary. */
export interface LotePreparado {
  identificador: string;
  nombreBase: string;
  xmlFirmado: string;
  digestValue: string;
  signatureValue: string;
  zip: PaqueteZip;
}

/**
 * Fachada del núcleo: valida → construye el UBL → firma con el material del
 * panel → empaqueta en ZIP → arma la cadena del QR. Si la validación falla
 * lanza DocumentoCpeInvalidoError antes de firmar (el número no se usa en SUNAT).
 */
export class PreparadorEnvioCpe {
  constructor(
    private readonly validador: ValidadorDocumentoCpe = new ValidadorDocumentoCpe(),
    private readonly fabrica: FabricaConstructoresXmlCpe = new FabricaConstructoresXmlCpe(),
    private readonly firmador: FirmadorXmlSunat = new FirmadorXmlSunat(),
    private readonly constructorResumen: ConstructorResumenDiarioUbl = new ConstructorResumenDiarioUbl(),
    private readonly constructorBaja: ConstructorComunicacionBajaUbl = new ConstructorComunicacionBajaUbl(),
  ) {}

  prepararComprobante(doc: DocumentoCpe, material: MaterialFirma, opciones: OpcionesPreparacionCpe = {}): EnvioCpePreparado {
    const advertencias = this.validador.asegurarValido(doc, opciones);
    const { xml, nombreBase } = this.fabrica.construir(doc);
    const firma = this.firmador.firmar(xml, material, opciones);
    return {
      nombreBase,
      xmlSinFirmar: xml,
      xmlFirmado: firma.xmlFirmado,
      digestValue: firma.digestValue,
      signatureValue: firma.signatureValue,
      zip: empaquetarZip(nombreBase, firma.xmlFirmado),
      cadenaQr: construirCadenaQr({
        ruc: doc.emisor.ruc,
        tipo: doc.tipo,
        serie: doc.serie,
        numero: doc.numero,
        igv: doc.totales.igv,
        total: doc.totales.total,
        fechaEmision: doc.fechaEmision,
        tipoDocAdq: doc.cliente.tipoDoc,
        numDocAdq: doc.cliente.numDoc,
        digest: firma.digestValue,
      }),
      advertencias,
    };
  }

  prepararResumenDiario(datos: DatosResumenDiario, material: MaterialFirma, opciones: OpcionesFirmaXml = {}): LotePreparado {
    const { xml, identificador, nombreBase } = this.constructorResumen.construir(datos);
    return this.firmarLote(xml, identificador, nombreBase, material, opciones);
  }

  prepararComunicacionBaja(datos: DatosComunicacionBaja, material: MaterialFirma, opciones: OpcionesFirmaXml = {}): LotePreparado {
    const { xml, identificador, nombreBase } = this.constructorBaja.construir(datos);
    return this.firmarLote(xml, identificador, nombreBase, material, opciones);
  }

  /** Vuelve a empaquetar un XML firmado ya guardado (reenvío con el mismo hash, sin volver a firmar). */
  reempaquetar(nombreBase: string, xmlFirmado: string): PaqueteZip & { digestValue: string | null } {
    return { ...empaquetarZip(nombreBase, xmlFirmado), digestValue: extraerDigestValue(xmlFirmado) };
  }

  private firmarLote(xml: string, identificador: string, nombreBase: string, material: MaterialFirma, opciones: OpcionesFirmaXml): LotePreparado {
    const firma = this.firmador.firmar(xml, material, opciones);
    return {
      identificador,
      nombreBase,
      xmlFirmado: firma.xmlFirmado,
      digestValue: firma.digestValue,
      signatureValue: firma.signatureValue,
      zip: empaquetarZip(nombreBase, firma.xmlFirmado),
    };
  }
}
