import type { DocumentoCpe, OpcionesValidacionCpe, ResultadoXmlCpe, TipoCpe } from './documento-fiscal.types';
import { ErrorNucleoFiscal } from './errores-nucleo';
import { nombreBaseCpe } from './identificadores-cpe';
import { ConstructorXmlDocumentoCpe } from './ubl/constructor-ubl-cpe';
import { ConstructorFacturaBoletaUbl, ConstructorNotaCreditoUbl, ConstructorNotaDebitoUbl } from './ubl/constructores-cpe';
import { ValidadorDocumentoCpe } from './validaciones-cpe';

/** Elige el constructor UBL según el tipo de comprobante (patrón fábrica). */
export class FabricaConstructoresXmlCpe {
  private readonly porTipo = new Map<TipoCpe, ConstructorXmlDocumentoCpe>();

  constructor(
    constructores: readonly ConstructorXmlDocumentoCpe[] = [
      new ConstructorFacturaBoletaUbl(),
      new ConstructorNotaCreditoUbl(),
      new ConstructorNotaDebitoUbl(),
    ],
  ) {
    for (const constructor of constructores) {
      for (const tipo of constructor.tiposSoportados) this.porTipo.set(tipo, constructor);
    }
  }

  para(tipo: TipoCpe): ConstructorXmlDocumentoCpe {
    const constructor = this.porTipo.get(tipo);
    if (!constructor) {
      throw new ErrorNucleoFiscal('FISCAL_TIPO_NO_SOPORTADO', `No hay constructor UBL para el tipo de comprobante "${tipo}".`);
    }
    return constructor;
  }

  construir(doc: DocumentoCpe): ResultadoXmlCpe {
    const xml = this.para(doc?.tipo).construir(doc);
    return { xml, nombreBase: nombreBaseCpe(doc.emisor.ruc, doc.tipo, doc.serie, doc.numero) };
  }
}

const fabricaPorOmision = new FabricaConstructoresXmlCpe();

/**
 * XML UBL 2.1 sin firmar de una factura, boleta, nota de crédito o de débito.
 * No valida reglas de negocio (use validarDocumentoCpe antes) ni recalcula
 * impuestos: escribe los importes de las líneas tal como llegan.
 * nombreBase = RUC-TT-SERIE-NNNNNNNN (nombre del .xml y del .zip).
 */
export function construirXmlCpe(doc: DocumentoCpe): ResultadoXmlCpe {
  return fabricaPorOmision.construir(doc);
}

/** Valida (lanza DocumentoCpeInvalidoError si hay errores) y construye. Devuelve también las advertencias. */
export function construirXmlCpeValidado(
  doc: DocumentoCpe,
  opciones: OpcionesValidacionCpe = {},
  validador: ValidadorDocumentoCpe = new ValidadorDocumentoCpe(),
): ResultadoXmlCpe & { advertencias: string[] } {
  const advertencias = validador.asegurarValido(doc, opciones);
  return { ...construirXmlCpe(doc), advertencias };
}
