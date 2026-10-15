import type { DocumentoCpe, OpcionesValidacionCpe, ResultadoValidacionCpe } from './documento-fiscal.types';
import { DocumentoCpeInvalidoError } from './errores-nucleo';
import { AcumuladorValidacion, ContextoValidacionCpe, ReglaValidacionCpe } from './validacion/base-validacion';
import { ReglaAdquirente } from './validacion/reglas-cliente';
import { ReglaEmisor, ReglaFechasYPlazos, ReglaMoneda, ReglaSerieNumero } from './validacion/reglas-cabecera';
import { ReglaLineas } from './validacion/reglas-lineas';
import { ReglaNota } from './validacion/reglas-nota';
import { ReglaFormaPago, ReglaTotales } from './validacion/reglas-totales';

export type { ReglaValidacionCpe } from './validacion/base-validacion';
export { AcumuladorValidacion, ContextoValidacionCpe } from './validacion/base-validacion';

/** Reglas por omisión, en el orden en que se informan. */
export const REGLAS_VALIDACION_CPE: readonly ReglaValidacionCpe[] = Object.freeze([
  new ReglaSerieNumero(),
  new ReglaFechasYPlazos(),
  new ReglaMoneda(),
  new ReglaEmisor(),
  new ReglaAdquirente(),
  new ReglaNota(),
  new ReglaLineas(),
  new ReglaTotales(),
  new ReglaFormaPago(),
]);

/**
 * Validaciones previas al envío. Un error impide firmar y enviar (el número
 * no se quema en SUNAT); una advertencia se informa y no bloquea.
 * Se puede componer con reglas propias (patrón estrategia).
 */
export class ValidadorDocumentoCpe {
  constructor(private readonly reglas: readonly ReglaValidacionCpe[] = REGLAS_VALIDACION_CPE) {}

  validar(doc: DocumentoCpe, opciones: OpcionesValidacionCpe = {}): ResultadoValidacionCpe {
    const acumulador = new AcumuladorValidacion();
    if (!doc || typeof doc !== 'object') {
      acumulador.error('No se recibió el comprobante a validar.');
      return acumulador.resultado();
    }
    const contexto = new ContextoValidacionCpe(doc, opciones);
    for (const regla of this.reglas) {
      try {
        regla.validar(contexto, acumulador);
      } catch (error) {
        // Un dato con forma inesperada no debe tumbar la emisión: queda como error del documento.
        acumulador.error(`No se pudo validar (${regla.nombre}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return acumulador.resultado();
  }

  /** Valida y lanza DocumentoCpeInvalidoError si hay errores; devuelve las advertencias. */
  asegurarValido(doc: DocumentoCpe, opciones: OpcionesValidacionCpe = {}): string[] {
    const { errores, advertencias } = this.validar(doc, opciones);
    if (errores.length > 0) throw new DocumentoCpeInvalidoError(errores, undefined, advertencias);
    return advertencias;
  }
}

const validadorPorOmision = new ValidadorDocumentoCpe();

/** validarDocumentoCpe(doc, { hoy?, aplicarReglas2027?, montoMaximoNota? }) → { errores, advertencias } */
export function validarDocumentoCpe(doc: DocumentoCpe, opciones: OpcionesValidacionCpe = {}): ResultadoValidacionCpe {
  return validadorPorOmision.validar(doc, opciones);
}

/** Igual que validarDocumentoCpe pero lanza DocumentoCpeInvalidoError (código FISCAL_DOCUMENTO_INVALIDO) si hay errores. */
export function asegurarDocumentoCpeValido(doc: DocumentoCpe, opciones: OpcionesValidacionCpe = {}): string[] {
  return validadorPorOmision.asegurarValido(doc, opciones);
}
