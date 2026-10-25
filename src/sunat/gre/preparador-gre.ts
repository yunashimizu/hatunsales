import type { MaterialFirma } from '../nucleo/documento-fiscal.types';
import { DocumentoCpeInvalidoError } from '../nucleo/errores-nucleo';
import { FirmadorXmlSunat, OpcionesFirmaXml } from '../nucleo/firma/firmador-xml';
import { empaquetarZip } from '../nucleo/zip/paquete-zip';
import { ConstructorGreUbl } from './constructor-gre-ubl';
import type { GrePreparada } from './gre.contrato';
import type { DocumentoGre } from './gre.tipos';
import { OpcionesValidacionGre, validarDocumentoGre } from './validaciones-gre';

export type OpcionesPreparacionGre = OpcionesValidacionGre & OpcionesFirmaXml;

/**
 * La guía no pasa las validaciones previas: no se firma ni se envía (el número no llega a SUNAT).
 * Hereda de DocumentoCpeInvalidoError (código FISCAL_DOCUMENTO_INVALIDO) para que el negocio la trate
 * como cualquier documento inválido; `errores` y `advertencias` traen los mensajes por campo.
 */
export class GreInvalidaError extends DocumentoCpeInvalidoError {
  constructor(errores: readonly string[], advertencias: readonly string[] = []) {
    super(errores, `La guía de remisión no pasa las validaciones previas al envío: ${errores.join(' | ')}`, advertencias);
    this.name = 'GreInvalidaError';
  }
}

/**
 * Valida → arma el DespatchAdvice → firma con el material recibido → empaqueta el ZIP (un solo XML con
 * el mismo nombre) y calcula su SHA-256 en hexadecimal (hashZip del envío). Sin red ni base de datos:
 * el material lo entrega quien llama (GreEmisionService lo pide al certificado de producción).
 */
export class PreparadorGre {
  constructor(
    private readonly constructorUbl: ConstructorGreUbl = new ConstructorGreUbl(),
    private readonly firmador: FirmadorXmlSunat = new FirmadorXmlSunat(),
  ) {}

  preparar(documento: DocumentoGre, material: MaterialFirma, opciones: OpcionesPreparacionGre = {}): GrePreparada {
    const validacion = validarDocumentoGre(documento, opciones);
    if (validacion.errores.length > 0) throw new GreInvalidaError(validacion.errores, validacion.advertencias);

    // Copia: lo que se guarda junto al ZIP es exactamente lo que se firmó, aunque el llamador cambie su objeto.
    const copia = structuredClone(documento);
    const { xml, nombreBase } = this.constructorUbl.construir(copia);
    const firma = this.firmador.firmar(xml, material, opciones);
    const paquete = empaquetarZip(nombreBase, firma.xmlFirmado);
    return {
      documento: copia,
      nombreBase,
      xml,
      xmlFirmado: firma.xmlFirmado,
      zip: paquete.zip,
      zipBase64: paquete.base64,
      sha256: paquete.sha256,
      digestValue: firma.digestValue,
      advertencias: validacion.advertencias,
    };
  }
}
