/**
 * Monto en soles con aritmética exacta: se guarda en céntimos enteros y nunca se opera
 * con decimales de punto flotante. Inmutable.
 */

/** Tope defensivo: NUMERIC(12,2) admite hasta 9 999 999 999.99. */
const MAX_CENTIMOS = 999_999_999_999;
const PATRON_DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

export class DineroInvalidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'DineroInvalidoError';
  }
}

export class Dinero {
  private constructor(readonly centimos: number) {}

  static readonly CERO = new Dinero(0);

  static cero(): Dinero {
    return Dinero.CERO;
  }

  static deCentimos(centimos: number): Dinero {
    if (!Number.isSafeInteger(centimos)) {
      throw new DineroInvalidoError(`Céntimos inválidos: ${centimos}`);
    }
    if (Math.abs(centimos) > MAX_CENTIMOS) {
      throw new DineroInvalidoError('El monto supera el máximo permitido.');
    }
    return centimos === 0 ? Dinero.CERO : new Dinero(centimos);
  }

  /**
   * Monto que llega del cliente (JSON). Rechaza más de 2 decimales en lugar de redondear
   * en silencio: 12.345 es un error de captura, no un monto.
   */
  static deSoles(valor: number): Dinero {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      throw new DineroInvalidoError('El monto debe ser un número.');
    }
    const escalado = valor * 100;
    const centimos = Math.round(escalado);
    if (Math.abs(escalado - centimos) > 1e-6) {
      throw new DineroInvalidoError(`El monto ${valor} tiene más de 2 decimales.`);
    }
    return Dinero.deCentimos(centimos === 0 ? 0 : centimos);
  }

  /**
   * Valor NUMERIC que devuelve PostgreSQL (texto '1234.50', '-3', '0.005'...). Si trae más
   * de 2 decimales redondea a 2, alejándose de cero en el medio (como ROUND de PostgreSQL).
   * null/undefined/'' valen cero.
   */
  static desdeBd(valor: unknown): Dinero {
    if (valor === null || valor === undefined || valor === '') return Dinero.CERO;
    if (typeof valor === 'number') return Dinero.desdeNumeroRedondeado(valor);
    const m = PATRON_DECIMAL.exec(String(valor).trim());
    if (!m) throw new DineroInvalidoError(`Monto de la BD ilegible: ${String(valor)}`);
    const negativo = m[1] === '-';
    const entero = m[2];
    const fraccion = (m[3] ?? '').padEnd(3, '0');
    let centimos = Number(entero) * 100 + Number(fraccion.slice(0, 2));
    if (Number(fraccion[2]) >= 5) centimos += 1;
    return Dinero.deCentimos(negativo ? -centimos : centimos);
  }

  /** Número ya calculado (por ejemplo, de un cálculo heredado) redondeado al céntimo. */
  static desdeNumeroRedondeado(valor: number): Dinero {
    if (!Number.isFinite(valor)) throw new DineroInvalidoError('El monto debe ser un número.');
    // toFixed evita el clásico 1.005 * 100 = 100.49999…
    const texto = Math.abs(valor).toFixed(6);
    const d = Dinero.desdeBd(texto);
    return valor < 0 ? d.negar() : d;
  }

  static sumarTodos(montos: Iterable<Dinero>): Dinero {
    let total = 0;
    for (const m of montos) total += m.centimos;
    return Dinero.deCentimos(total);
  }

  sumar(otro: Dinero): Dinero {
    return Dinero.deCentimos(this.centimos + otro.centimos);
  }

  restar(otro: Dinero): Dinero {
    return Dinero.deCentimos(this.centimos - otro.centimos);
  }

  multiplicar(factorEntero: number): Dinero {
    if (!Number.isSafeInteger(factorEntero)) {
      throw new DineroInvalidoError('Solo se multiplica por cantidades enteras.');
    }
    return Dinero.deCentimos(this.centimos * factorEntero);
  }

  negar(): Dinero {
    return Dinero.deCentimos(-this.centimos);
  }

  abs(): Dinero {
    return this.centimos < 0 ? this.negar() : this;
  }

  esCero(): boolean {
    return this.centimos === 0;
  }

  esPositivo(): boolean {
    return this.centimos > 0;
  }

  esNegativo(): boolean {
    return this.centimos < 0;
  }

  igual(otro: Dinero): boolean {
    return this.centimos === otro.centimos;
  }

  mayorQue(otro: Dinero): boolean {
    return this.centimos > otro.centimos;
  }

  /** Para respuestas JSON: 12.5 → 12.5 (el double más cercano; JSON lo imprime exacto). */
  aNumero(): number {
    return this.centimos / 100;
  }

  /** '1234.50' / '-0.10': parámetro exacto para columnas NUMERIC. */
  aTexto(): string {
    const signo = this.centimos < 0 ? '-' : '';
    const abs = Math.abs(this.centimos);
    return `${signo}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  }

  /** 'S/ 1,234.50' (negativo: '-S/ 12.50'). */
  formatear(): string {
    const signo = this.centimos < 0 ? '-' : '';
    const [entero, fraccion] = this.abs().aTexto().split('.');
    return `${signo}S/ ${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraccion}`;
  }

  toJSON(): number {
    return this.aNumero();
  }

  toString(): string {
    return this.formatear();
  }
}
