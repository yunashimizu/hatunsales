import { ErrorNucleoFiscal } from './errores-nucleo';

/**
 * Aritmética decimal exacta para importes fiscales.
 *
 * Un `number` de JavaScript no representa 0.1 ni 1.005 de forma exacta, y
 * `toFixed` redondea sobre el binario (1.005.toFixed(2) === '1.00'). Aquí cada
 * valor se toma por su representación decimal más corta y se opera con BigInt,
 * así que el redondeo es el que espera SUNAT: medio hacia afuera (1.005 → 1.01).
 */

const PATRON_DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const ESCALA_MAXIMA = 40;

const potenciasDe10 = new Map<number, bigint>();
function potencia10(exponente: number): bigint {
  let valor = potenciasDe10.get(exponente);
  if (valor === undefined) {
    valor = 10n ** BigInt(exponente);
    if (exponente <= 64) potenciasDe10.set(exponente, valor);
  }
  return valor;
}

function valorAbsoluto(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** División entera de BigInt redondeando medio hacia afuera (lejos de cero). */
function dividirRedondeando(numerador: bigint, denominador: bigint): bigint {
  if (denominador === 0n) {
    throw new ErrorNucleoFiscal('FISCAL_MONTO_INVALIDO', 'División entre cero en un cálculo fiscal.');
  }
  const negativo = (numerador < 0n) !== (denominador < 0n);
  const n = valorAbsoluto(numerador);
  const d = valorAbsoluto(denominador);
  let cociente = n / d;
  if ((n % d) * 2n >= d) cociente += 1n;
  return negativo ? -cociente : cociente;
}

export type ValorDecimal = number | string | bigint | DecimalExacto;

/** Decimal inmutable: valor = unidades / 10^escala. */
export class DecimalExacto {
  private constructor(
    private readonly unidades: bigint,
    private readonly escala: number,
  ) {}

  static cero(): DecimalExacto {
    return new DecimalExacto(0n, 0);
  }

  static de(valor: ValorDecimal): DecimalExacto {
    if (valor instanceof DecimalExacto) return valor;
    if (typeof valor === 'bigint') return new DecimalExacto(valor, 0);
    if (typeof valor === 'number') {
      if (!Number.isFinite(valor)) throw DecimalExacto.invalido(valor);
      return DecimalExacto.parsear(String(valor), valor);
    }
    if (typeof valor === 'string') return DecimalExacto.parsear(valor.trim(), valor);
    throw DecimalExacto.invalido(valor);
  }

  /** true si `valor` puede convertirse sin error (número finito o texto decimal). */
  static esValido(valor: unknown): boolean {
    if (typeof valor === 'number') return Number.isFinite(valor);
    if (typeof valor === 'string') {
      const m = PATRON_DECIMAL.exec(valor.trim());
      return !!m && `${m[2] ?? ''}${m[3] ?? ''}`.length > 0;
    }
    return typeof valor === 'bigint' || valor instanceof DecimalExacto;
  }

  private static parsear(texto: string, original: unknown): DecimalExacto {
    const m = PATRON_DECIMAL.exec(texto);
    const entero = m?.[2] ?? '';
    const fraccion = m?.[3] ?? '';
    if (!m || `${entero}${fraccion}`.length === 0) throw DecimalExacto.invalido(original);

    const signo = m[1] === '-' ? -1n : 1n;
    let unidades = BigInt(`${entero}${fraccion}` || '0') * signo;
    let escala = fraccion.length - Number(m[4] ?? 0);
    if (escala < 0) {
      unidades *= potencia10(-escala);
      escala = 0;
    }
    const decimal = new DecimalExacto(unidades, escala);
    return escala > ESCALA_MAXIMA ? decimal.redondear(ESCALA_MAXIMA) : decimal;
  }

  private static invalido(valor: unknown): ErrorNucleoFiscal {
    return new ErrorNucleoFiscal('FISCAL_MONTO_INVALIDO', `Valor numérico inválido para un cálculo fiscal: ${String(valor)}`);
  }

  private aEscala(escala: number): bigint {
    return escala === this.escala ? this.unidades : this.unidades * potencia10(escala - this.escala);
  }

  mas(otro: ValorDecimal): DecimalExacto {
    const o = DecimalExacto.de(otro);
    const escala = Math.max(this.escala, o.escala);
    return new DecimalExacto(this.aEscala(escala) + o.aEscala(escala), escala);
  }

  menos(otro: ValorDecimal): DecimalExacto {
    const o = DecimalExacto.de(otro);
    const escala = Math.max(this.escala, o.escala);
    return new DecimalExacto(this.aEscala(escala) - o.aEscala(escala), escala);
  }

  por(otro: ValorDecimal): DecimalExacto {
    const o = DecimalExacto.de(otro);
    const producto = new DecimalExacto(this.unidades * o.unidades, this.escala + o.escala);
    return producto.escala > ESCALA_MAXIMA ? producto.redondear(ESCALA_MAXIMA) : producto;
  }

  /** Divide y redondea (medio hacia afuera) al número de decimales indicado. */
  entre(divisor: ValorDecimal, decimales: number): DecimalExacto {
    const d = DecimalExacto.de(divisor);
    // (a / 10^ea) / (b / 10^eb) = a·10^(eb + dec) / (b·10^ea) en unidades de 10^-dec
    const numerador = this.unidades * potencia10(d.escala + decimales);
    const denominador = d.unidades * potencia10(this.escala);
    return new DecimalExacto(dividirRedondeando(numerador, denominador), decimales);
  }

  /** Redondeo medio hacia afuera (el de SUNAT): 1.005 → 1.01, −1.005 → −1.01. */
  redondear(decimales: number): DecimalExacto {
    if (decimales >= this.escala) return new DecimalExacto(this.aEscala(decimales), decimales);
    return new DecimalExacto(dividirRedondeando(this.unidades, potencia10(this.escala - decimales)), decimales);
  }

  comparar(otro: ValorDecimal): -1 | 0 | 1 {
    const o = DecimalExacto.de(otro);
    const escala = Math.max(this.escala, o.escala);
    const a = this.aEscala(escala);
    const b = o.aEscala(escala);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  abs(): DecimalExacto {
    return this.unidades < 0n ? new DecimalExacto(-this.unidades, this.escala) : this;
  }

  esCero(): boolean {
    return this.unidades === 0n;
  }

  esNegativo(): boolean {
    return this.unidades < 0n;
  }

  /** Cantidad de decimales significativos (sin ceros a la derecha). */
  decimalesSignificativos(): number {
    let unidades = valorAbsoluto(this.unidades);
    let escala = this.escala;
    while (escala > 0 && unidades % 10n === 0n) {
      unidades /= 10n;
      escala -= 1;
    }
    return escala;
  }

  aNumero(): number {
    return Number(this.aTexto(0, Math.max(this.escala, 0)));
  }

  /**
   * Texto con punto decimal: redondea a `maxDecimales` y quita los ceros a la
   * derecha sin bajar de `minDecimales`. aTexto(2, 10) de 11.8 → '11.80'.
   */
  aTexto(minDecimales = 0, maxDecimales: number = Math.max(this.escala, minDecimales)): string {
    const redondeado = this.redondear(maxDecimales);
    const negativo = redondeado.unidades < 0n;
    let digitos = valorAbsoluto(redondeado.unidades).toString().padStart(maxDecimales + 1, '0');
    let entero = maxDecimales > 0 ? digitos.slice(0, -maxDecimales) : digitos;
    let fraccion = maxDecimales > 0 ? digitos.slice(-maxDecimales) : '';
    fraccion = fraccion.replace(/0+$/, '');
    if (fraccion.length < minDecimales) fraccion = fraccion.padEnd(minDecimales, '0');
    entero = entero.replace(/^0+(?=\d)/, '');
    digitos = fraccion.length > 0 ? `${entero}.${fraccion}` : entero;
    const esCero = /^0(\.0*)?$/.test(digitos);
    return negativo && !esCero ? `-${digitos}` : digitos;
  }

  toString(): string {
    return this.aTexto();
  }
}

/** Importe en la moneda del comprobante, exacto al céntimo. */
export class Dinero {
  private constructor(private readonly valor: DecimalExacto) {}

  static de(valor: ValorDecimal | Dinero): Dinero {
    if (valor instanceof Dinero) return valor;
    return new Dinero(DecimalExacto.de(valor).redondear(2));
  }

  static desdeCentimos(centimos: number | bigint): Dinero {
    if (typeof centimos === 'number' && !Number.isSafeInteger(centimos)) {
      throw new ErrorNucleoFiscal('FISCAL_MONTO_INVALIDO', `Céntimos inválidos: ${centimos}`);
    }
    return new Dinero(DecimalExacto.de(BigInt(centimos)).entre(100, 2));
  }

  static cero(): Dinero {
    return new Dinero(DecimalExacto.cero().redondear(2));
  }

  static suma(valores: Iterable<ValorDecimal | Dinero>): Dinero {
    let total = Dinero.cero();
    for (const valor of valores) total = total.mas(valor);
    return total;
  }

  mas(otro: ValorDecimal | Dinero): Dinero {
    return new Dinero(this.valor.mas(Dinero.de(otro).valor));
  }

  menos(otro: ValorDecimal | Dinero): Dinero {
    return new Dinero(this.valor.menos(Dinero.de(otro).valor));
  }

  /** Multiplica por un factor (tasa, cantidad) y redondea al céntimo. */
  por(factor: ValorDecimal): Dinero {
    return new Dinero(this.valor.por(factor).redondear(2));
  }

  /** Divide (p. ej. total / cantidad) devolviendo un decimal con la precisión pedida. */
  entre(divisor: ValorDecimal, decimales: number): DecimalExacto {
    return this.valor.entre(divisor, decimales);
  }

  abs(): Dinero {
    return new Dinero(this.valor.abs());
  }

  comparar(otro: ValorDecimal | Dinero): -1 | 0 | 1 {
    return this.valor.comparar(Dinero.de(otro).valor);
  }

  mayorQue(otro: ValorDecimal | Dinero): boolean {
    return this.comparar(otro) > 0;
  }

  menorQue(otro: ValorDecimal | Dinero): boolean {
    return this.comparar(otro) < 0;
  }

  esCero(): boolean {
    return this.valor.esCero();
  }

  esNegativo(): boolean {
    return this.valor.esNegativo();
  }

  esPositivo(): boolean {
    return !this.esCero() && !this.esNegativo();
  }

  /** |this − otro| ≤ tolerancia (en céntimos). */
  igualA(otro: ValorDecimal | Dinero, toleranciaCentimos = 0): boolean {
    return this.diferenciaAbsoluta(otro).centimos <= toleranciaCentimos;
  }

  diferenciaAbsoluta(otro: ValorDecimal | Dinero): Dinero {
    return this.menos(otro).abs();
  }

  get centimos(): number {
    return this.valor.por(100).redondear(0).aNumero();
  }

  aDecimal(): DecimalExacto {
    return this.valor;
  }

  aNumero(): number {
    return this.valor.aNumero();
  }

  /** Siempre con dos decimales: '118.00'. */
  toString(): string {
    return this.valor.aTexto(2, 2);
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Redondeo SUNAT (medio hacia afuera) sobre un number. */
export function redondear(valor: ValorDecimal, decimales = 2): number {
  return DecimalExacto.de(valor).redondear(decimales).aNumero();
}

/** Formatea con hasta `maxDecimales` y al menos `minDecimales` decimales. */
export function formatearDecimal(valor: ValorDecimal, maxDecimales: number, minDecimales = 0): string {
  return DecimalExacto.de(valor).aTexto(minDecimales, maxDecimales);
}

/** Importe con dos decimales exactos ('8.47'). */
export function formatearMonto(valor: ValorDecimal | Dinero): string {
  return Dinero.de(valor).toString();
}
