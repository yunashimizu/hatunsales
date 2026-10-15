import { Dinero } from './dinero';
import { CategoriaMetodo, categoriaMetodo, seConciliaPorDeclaracion } from './metodo-pago';

/**
 * Lo que debería haber en caja al momento del arqueo, calculado con el modelo real:
 *
 *   efectivo esperado = monto inicial
 *                     + ventas de mostrador cobradas en efectivo (venta_pago.monto)
 *                     + abonos de crédito cobrados en efectivo por el cajero del turno
 *                     + ingresos − egresos de movimientos_caja
 *
 * venta_pago.monto ya es lo aplicado a la venta (lo recibido menos el vuelto): el POS envía
 * monto = total y aparte monto_recibido/vuelto. Por eso los vueltos NO se restan otra vez;
 * se informan para el cajero. Las ventas anuladas no cuentan (el dinero se devolvió) y las
 * ventas de la tienda web tampoco (se cobran fuera de la gaveta); ambas se informan aparte.
 */
export type FuenteCaja = 'venta' | 'abono' | 'ingreso' | 'egreso' | 'venta_web' | 'venta_anulada';

/** Fila agregada que devuelve el repositorio (una por fuente y medio de pago). */
export interface FilaFuenteCaja {
  fuente: FuenteCaja;
  id_metodo: number | null;
  nombre: string | null;
  tipo: string | null;
  total: Dinero;
  cantidad: number;
  /** Solo ventas: vuelto entregado (informativo). */
  vuelto?: Dinero;
}

export interface LineaMetodoEsperado {
  /** String(id_metodo) o 'sin_metodo'. */
  clave: string;
  id_metodo: number | null;
  nombre: string;
  categoria: CategoriaMetodo;
  ventas: Dinero;
  abonos: Dinero;
  esperado: Dinero;
  operaciones: number;
}

export interface EfectivoEsperado {
  monto_inicial: Dinero;
  ventas: Dinero;
  abonos: Dinero;
  ingresos: Dinero;
  egresos: Dinero;
  vueltos_entregados: Dinero;
  esperado: Dinero;
  operaciones_ventas: number;
  operaciones_abonos: number;
  cantidad_ingresos: number;
  cantidad_egresos: number;
  /** Desglose por método de tipo efectivo (EFECTIVO, Pago contra entrega…). */
  metodos: LineaMetodoEsperado[];
}

export interface EsperadoCaja {
  efectivo: EfectivoEsperado;
  /** Medios que se concilian contra lo declarado (Yape, Plin, tarjeta, transferencia, otros). */
  otros_medios: LineaMetodoEsperado[];
  /** Ventas al crédito: no es dinero recibido, solo se informa. */
  credito: { ventas: Dinero; operaciones: number };
  ventas_web: { total: Dinero; cantidad: number };
  ventas_anuladas: { total: Dinero; cantidad: number };
  /** Todo lo cobrado en el turno (sin crédito ni monto inicial). */
  total_cobrado: Dinero;
}

const NOMBRE_SIN_METODO = 'Sin medio de pago indicado';

function claveMetodo(idMetodo: number | null): string {
  return idMetodo == null ? 'sin_metodo' : String(idMetodo);
}

class AcumuladorMetodos {
  private readonly lineas = new Map<string, LineaMetodoEsperado>();

  agregar(fila: FilaFuenteCaja, categoria: CategoriaMetodo): void {
    const clave = claveMetodo(fila.id_metodo);
    const actual = this.lineas.get(clave) ?? {
      clave,
      id_metodo: fila.id_metodo,
      nombre: (fila.nombre ?? '').trim() || (fila.id_metodo == null ? NOMBRE_SIN_METODO : `Medio ${fila.id_metodo}`),
      categoria,
      ventas: Dinero.CERO,
      abonos: Dinero.CERO,
      esperado: Dinero.CERO,
      operaciones: 0,
    };
    const ventas = fila.fuente === 'venta' ? actual.ventas.sumar(fila.total) : actual.ventas;
    const abonos = fila.fuente === 'abono' ? actual.abonos.sumar(fila.total) : actual.abonos;
    this.lineas.set(clave, {
      ...actual,
      ventas,
      abonos,
      esperado: ventas.sumar(abonos),
      operaciones: actual.operaciones + fila.cantidad,
    });
  }

  lista(): LineaMetodoEsperado[] {
    return [...this.lineas.values()].sort(
      (a, b) => b.esperado.centimos - a.esperado.centimos || a.nombre.localeCompare(b.nombre, 'es'),
    );
  }
}

export class CalculadoraEsperado {
  static calcular(montoInicial: Dinero, filas: readonly FilaFuenteCaja[]): EsperadoCaja {
    const efectivo = new AcumuladorMetodos();
    const otros = new AcumuladorMetodos();
    let ingresos = Dinero.CERO;
    let egresos = Dinero.CERO;
    let cantidadIngresos = 0;
    let cantidadEgresos = 0;
    let vueltos = Dinero.CERO;
    let operacionesVentasEfectivo = 0;
    let operacionesAbonosEfectivo = 0;
    let credito = { ventas: Dinero.CERO, operaciones: 0 };
    let web = { total: Dinero.CERO, cantidad: 0 };
    let anuladas = { total: Dinero.CERO, cantidad: 0 };

    for (const fila of filas) {
      switch (fila.fuente) {
        case 'ingreso':
          ingresos = ingresos.sumar(fila.total);
          cantidadIngresos += fila.cantidad;
          break;
        case 'egreso':
          egresos = egresos.sumar(fila.total);
          cantidadEgresos += fila.cantidad;
          break;
        case 'venta_web':
          web = { total: web.total.sumar(fila.total), cantidad: web.cantidad + fila.cantidad };
          break;
        case 'venta_anulada':
          anuladas = { total: anuladas.total.sumar(fila.total), cantidad: anuladas.cantidad + fila.cantidad };
          break;
        case 'venta':
        case 'abono': {
          const categoria = categoriaMetodo(fila.tipo, fila.nombre);
          if (categoria === 'credito') {
            // Un abono "a crédito" no tiene sentido; solo cuentan las ventas.
            if (fila.fuente === 'venta') {
              credito = { ventas: credito.ventas.sumar(fila.total), operaciones: credito.operaciones + fila.cantidad };
            }
          } else if (categoria === 'efectivo') {
            efectivo.agregar(fila, categoria);
            if (fila.fuente === 'venta') {
              operacionesVentasEfectivo += fila.cantidad;
              if (fila.vuelto) vueltos = vueltos.sumar(fila.vuelto);
            } else {
              operacionesAbonosEfectivo += fila.cantidad;
            }
          } else if (seConciliaPorDeclaracion(categoria)) {
            otros.agregar(fila, categoria);
          }
          break;
        }
      }
    }

    const metodosEfectivo = efectivo.lista();
    const ventasEfectivo = Dinero.sumarTodos(metodosEfectivo.map((m) => m.ventas));
    const abonosEfectivo = Dinero.sumarTodos(metodosEfectivo.map((m) => m.abonos));
    const otrosMedios = otros.lista();

    return {
      efectivo: {
        monto_inicial: montoInicial,
        ventas: ventasEfectivo,
        abonos: abonosEfectivo,
        ingresos,
        egresos,
        vueltos_entregados: vueltos,
        esperado: montoInicial.sumar(ventasEfectivo).sumar(abonosEfectivo).sumar(ingresos).restar(egresos),
        operaciones_ventas: operacionesVentasEfectivo,
        operaciones_abonos: operacionesAbonosEfectivo,
        cantidad_ingresos: cantidadIngresos,
        cantidad_egresos: cantidadEgresos,
        metodos: metodosEfectivo,
      },
      otros_medios: otrosMedios,
      credito,
      ventas_web: web,
      ventas_anuladas: anuladas,
      total_cobrado: ventasEfectivo
        .sumar(abonosEfectivo)
        .sumar(Dinero.sumarTodos(otrosMedios.map((m) => m.esperado))),
    };
  }
}
