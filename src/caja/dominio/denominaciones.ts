import { Dinero } from './dinero';
import { ErrorCaja } from './errores-caja';

/** Billetes y monedas en circulación (soles). */
export type TipoDenominacion = 'billete' | 'moneda';

export interface Denominacion {
  tipo: TipoDenominacion;
  valor: Dinero;
  /** 'S/ 200' / 'S/ 0.50' */
  etiqueta: string;
}

function den(tipo: TipoDenominacion, centimos: number): Denominacion {
  const valor = Dinero.deCentimos(centimos);
  const etiqueta = centimos % 100 === 0 ? `S/ ${centimos / 100}` : valor.formatear();
  return { tipo, valor, etiqueta };
}

/** De mayor a menor, como se cuenta la gaveta. */
export const DENOMINACIONES_PEN: readonly Denominacion[] = Object.freeze([
  den('billete', 20_000),
  den('billete', 10_000),
  den('billete', 5_000),
  den('billete', 2_000),
  den('billete', 1_000),
  den('moneda', 500),
  den('moneda', 200),
  den('moneda', 100),
  den('moneda', 50),
  den('moneda', 20),
  den('moneda', 10),
]);

/** Tope por denominación: 100 000 piezas (S/ 20 000 000 en billetes de 200). */
export const MAX_CANTIDAD_POR_DENOMINACION = 100_000;

export interface ConteoDenominacionEntrada {
  tipo?: string | null;
  /** Valor en soles: 200, 0.5, '0.50'… */
  denominacion: number | string;
  cantidad: number;
}

export interface LineaConteo {
  tipo: TipoDenominacion;
  denominacion: Dinero;
  etiqueta: string;
  cantidad: number;
  subtotal: Dinero;
}

function buscarDenominacion(valor: Dinero): Denominacion | undefined {
  return DENOMINACIONES_PEN.find((d) => d.valor.igual(valor));
}

function leerValor(denominacion: number | string): Dinero {
  try {
    return typeof denominacion === 'number' ? Dinero.deSoles(denominacion) : Dinero.desdeBd(denominacion);
  } catch {
    throw ErrorCaja.datoInvalido(`Denominación inválida: ${String(denominacion)}.`);
  }
}

/** Conteo físico del efectivo de la gaveta. El total lo calcula siempre el servidor. */
export class ConteoEfectivo {
  private constructor(readonly lineas: readonly LineaConteo[]) {}

  static vacio(): ConteoEfectivo {
    return new ConteoEfectivo([]);
  }

  /**
   * Valida y normaliza: solo denominaciones de soles en circulación, sin repetir,
   * cantidades enteras de 0 a MAX_CANTIDAD_POR_DENOMINACION. Las líneas en cero se omiten.
   */
  static desde(entradas: readonly ConteoDenominacionEntrada[]): ConteoEfectivo {
    if (!Array.isArray(entradas)) throw ErrorCaja.datoInvalido('El conteo debe ser una lista de denominaciones.');
    const vistas = new Set<number>();
    const lineas: LineaConteo[] = [];

    for (const entrada of entradas) {
      const valor = leerValor(entrada?.denominacion);
      const catalogo = buscarDenominacion(valor);
      if (!catalogo) {
        throw ErrorCaja.datoInvalido(
          `${valor.formatear()} no es un billete ni una moneda de soles en circulación.`,
        );
      }
      const tipo = entrada.tipo == null || entrada.tipo === '' ? catalogo.tipo : String(entrada.tipo).toLowerCase();
      if (tipo !== catalogo.tipo) {
        throw ErrorCaja.datoInvalido(`${catalogo.etiqueta} es ${catalogo.tipo === 'billete' ? 'un billete' : 'una moneda'}.`);
      }
      if (vistas.has(valor.centimos)) {
        throw ErrorCaja.datoInvalido(`La denominación ${catalogo.etiqueta} está repetida.`);
      }
      vistas.add(valor.centimos);

      const cantidad = entrada.cantidad;
      if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > MAX_CANTIDAD_POR_DENOMINACION) {
        throw ErrorCaja.datoInvalido(
          `La cantidad de ${catalogo.etiqueta} debe ser un entero entre 0 y ${MAX_CANTIDAD_POR_DENOMINACION.toLocaleString('en-US')}.`,
        );
      }
      if (cantidad === 0) continue;
      lineas.push({
        tipo: catalogo.tipo,
        denominacion: catalogo.valor,
        etiqueta: catalogo.etiqueta,
        cantidad,
        subtotal: catalogo.valor.multiplicar(cantidad),
      });
    }

    lineas.sort((a, b) => b.denominacion.centimos - a.denominacion.centimos);
    return new ConteoEfectivo(lineas);
  }

  /** Reconstruye un conteo guardado (filas de caja_arqueo_denominaciones). */
  static desdeGuardado(filas: { tipo: string; denominacion: unknown; cantidad: unknown }[]): ConteoEfectivo {
    return ConteoEfectivo.desde(
      filas.map((f) => ({ tipo: f.tipo, denominacion: String(f.denominacion), cantidad: Number(f.cantidad) })),
    );
  }

  total(): Dinero {
    return Dinero.sumarTodos(this.lineas.map((l) => l.subtotal));
  }

  totalBilletes(): Dinero {
    return Dinero.sumarTodos(this.lineas.filter((l) => l.tipo === 'billete').map((l) => l.subtotal));
  }

  totalMonedas(): Dinero {
    return Dinero.sumarTodos(this.lineas.filter((l) => l.tipo === 'moneda').map((l) => l.subtotal));
  }

  estaVacio(): boolean {
    return this.lineas.length === 0;
  }

  /** Las 11 denominaciones con su cantidad (0 si no se contó), para pantalla e impresión. */
  catalogoCompleto(): LineaConteo[] {
    return DENOMINACIONES_PEN.map((d) => {
      const linea = this.lineas.find((l) => l.denominacion.igual(d.valor));
      return linea ?? { tipo: d.tipo, denominacion: d.valor, etiqueta: d.etiqueta, cantidad: 0, subtotal: Dinero.CERO };
    });
  }
}
