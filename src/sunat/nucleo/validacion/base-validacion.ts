import { reglas2027Vigentes } from '../../catalogos/sunat.catalogos';
import { DecimalExacto, Dinero } from '../decimal';
import type { DocumentoCpe, OpcionesValidacionCpe, ResultadoValidacionCpe } from '../documento-fiscal.types';
import { esFechaIso, resolverHoy } from '../fechas-fiscales';

/** Acumula errores (bloquean el envío) y advertencias (se informan, no bloquean). */
export class AcumuladorValidacion {
  private readonly listaErrores: string[] = [];
  private readonly listaAdvertencias: string[] = [];

  error(mensaje: string): void {
    if (!this.listaErrores.includes(mensaje)) this.listaErrores.push(mensaje);
  }

  advertencia(mensaje: string): void {
    if (!this.listaAdvertencias.includes(mensaje)) this.listaAdvertencias.push(mensaje);
  }

  get hayErrores(): boolean {
    return this.listaErrores.length > 0;
  }

  resultado(): ResultadoValidacionCpe {
    return { errores: [...this.listaErrores], advertencias: [...this.listaAdvertencias] };
  }
}

/** Datos derivados que comparten todas las reglas de una validación. */
export class ContextoValidacionCpe {
  readonly hoy: string;
  readonly aplicarReglas2027: boolean;
  readonly montoMaximoNota?: number;

  constructor(
    readonly doc: DocumentoCpe,
    opciones: OpcionesValidacionCpe = {},
  ) {
    this.hoy = resolverHoy(opciones.hoy ?? null);
    const fechaReferencia = esFechaIso(doc?.fechaEmision) ? doc.fechaEmision : this.hoy;
    // Desde el 01/01/2027 (RS 000143-2026) son obligatorias: 'false' ya no las apaga, solo evita
    // adelantarlas; true las aplica también a documentos anteriores.
    this.aplicarReglas2027 = reglas2027Vigentes(fechaReferencia) || opciones.aplicarReglas2027 === true;
    this.montoMaximoNota = opciones.montoMaximoNota;
  }

  get esNota(): boolean {
    return this.doc.tipo === '07' || this.doc.tipo === '08';
  }

  /** Tipo que gobierna serie, adquirente y plazos: el propio (01/03) o el del documento modificado (notas). */
  get tipoBase(): '01' | '03' | null {
    if (this.doc.tipo === '01' || this.doc.tipo === '03') return this.doc.tipo;
    const tipo = this.doc.referencia?.tipoDoc;
    return tipo === '01' || tipo === '03' ? tipo : null;
  }

  get nombreDocumento(): string {
    switch (this.doc.tipo) {
      case '01':
        return 'la factura';
      case '03':
        return 'la boleta';
      case '07':
        return 'la nota de crédito';
      case '08':
        return 'la nota de débito';
      default:
        return 'el comprobante';
    }
  }
}

/** Una regla de negocio o de SUNAT. Cada regla es pequeña y no conoce a las demás. */
export interface ReglaValidacionCpe {
  readonly nombre: string;
  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void;
}

/** Controles C0 y DEL (prohibidos en descripciones y sustentos). Se permiten tabulador y saltos de línea. */
export const PATRON_CARACTERES_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function esNumeroFinito(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor);
}

/** true si el número tiene más decimales de los permitidos. */
export function excedeDecimales(valor: number, maximo: number): boolean {
  return DecimalExacto.de(valor).decimalesSignificativos() > maximo;
}

/**
 * Valida un importe: número finito, no negativo (o positivo si se exige) y
 * con como máximo `decimales`. Devuelve el motivo del error o null.
 */
export function errorImporte(valor: unknown, opciones: { positivo?: boolean; decimales?: number } = {}): string | null {
  const decimales = opciones.decimales ?? 2;
  if (!esNumeroFinito(valor)) return 'debe ser un número';
  if (opciones.positivo ? valor <= 0 : valor < 0) return opciones.positivo ? 'debe ser mayor que cero' : 'no puede ser negativo';
  if (excedeDecimales(valor, decimales)) return `admite como máximo ${decimales} decimales`;
  return null;
}

/** |a − b| en céntimos (ambos redondeados al céntimo). */
export function diferenciaCentimos(a: number, b: number): number {
  return Dinero.de(a).diferenciaAbsoluta(b).centimos;
}

export function formatoMonto(valor: number): string {
  return esNumeroFinito(valor) ? Dinero.de(valor).toString() : String(valor);
}

export function textoLimpio(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim() : valor === null || valor === undefined ? '' : String(valor).trim();
}
