/**
 * Objeto de valor RUC (11 dígitos, prefijo 10/15/16/17/20 y dígito verificador
 * módulo 11 de SUNAT).
 */
export class Ruc {
  private static readonly PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
  private static readonly PREFIJOS = new Set(['10', '15', '16', '17', '20']);
  /** 11 dígitos que no estén pegados a otros dígitos ("RUC20610206337" o "VATPE-20610206337"). */
  private static readonly CANDIDATO = /(?<!\d)(?:10|15|16|17|20)\d{9}(?!\d)/g;

  private constructor(readonly valor: string) {}

  static esValido(valor: unknown): boolean {
    if (typeof valor !== 'string' || !/^\d{11}$/.test(valor)) return false;
    if (!Ruc.PREFIJOS.has(valor.slice(0, 2))) return false;

    const suma = Ruc.PESOS.reduce((acc, peso, i) => acc + peso * Number(valor[i]), 0);
    const resto = 11 - (suma % 11);
    const verificador = resto === 10 ? 0 : resto === 11 ? 1 : resto;
    return verificador === Number(valor[10]);
  }

  /** null si no es un RUC válido. */
  static intentar(valor: unknown): Ruc | null {
    const limpio = typeof valor === 'string' ? valor.trim() : '';
    return Ruc.esValido(limpio) ? new Ruc(limpio) : null;
  }

  /** Primer RUC válido que aparezca dentro de un texto libre (campos del certificado). */
  static buscarEn(texto: string | null | undefined): string | null {
    if (!texto) return null;
    for (const coincidencia of texto.matchAll(Ruc.CANDIDATO)) {
      if (Ruc.esValido(coincidencia[0])) return coincidencia[0];
    }
    return null;
  }

  toString(): string {
    return this.valor;
  }
}
