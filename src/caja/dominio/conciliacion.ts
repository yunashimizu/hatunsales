import { Dinero } from './dinero';
import { EsperadoCaja, LineaMetodoEsperado } from './esperado-caja';
import { CategoriaMetodo, categoriaMetodo, MetodoPagoCaja, seConciliaPorDeclaracion } from './metodo-pago';
import { ErrorCaja } from './errores-caja';

/** Comparación de lo esperado contra lo contado (efectivo) o declarado (otros medios). */
export type EstadoConciliacion = 'cuadra' | 'faltante' | 'sobrante' | 'sin_declarar';

export interface LineaConciliada {
  /** 'efectivo' o String(id_metodo) / 'sin_metodo'. */
  clave: string;
  id_metodo: number | null;
  nombre: string;
  categoria: CategoriaMetodo;
  esperado: Dinero;
  declarado: Dinero | null;
  /** declarado − esperado (negativo = faltante). */
  diferencia: Dinero | null;
  estado: EstadoConciliacion;
  mensaje: string;
}

export interface ResultadoConciliacion {
  efectivo: LineaConciliada;
  otros_medios: LineaConciliada[];
  /** Alguna diferencia supera la tolerancia: se exige observación. */
  hay_diferencia: boolean;
  /** 'Cuadra' o 'Faltante de S/ 12.50 en efectivo; sobrante de S/ 3.00 en Yape'. */
  resumen: string;
}

export interface DeclaracionMedio {
  id_metodo: number;
  declarado: Dinero;
}

/** Tope de la tolerancia configurable (soles): más que esto deja de ser redondeo. */
export const TOLERANCIA_MAXIMA = Dinero.deCentimos(500);

export function describirDiferencia(
  diferencia: Dinero,
  tolerancia: Dinero = Dinero.CERO,
): { estado: Exclude<EstadoConciliacion, 'sin_declarar'>; mensaje: string; dentroDeTolerancia: boolean } {
  if (diferencia.esCero()) return { estado: 'cuadra', mensaje: 'Cuadra', dentroDeTolerancia: true };
  if (!diferencia.abs().mayorQue(tolerancia)) {
    return {
      estado: 'cuadra',
      mensaje: `Cuadra (diferencia de ${diferencia.abs().formatear()} dentro de la tolerancia)`,
      dentroDeTolerancia: true,
    };
  }
  return diferencia.esNegativo()
    ? { estado: 'faltante', mensaje: `Faltante de ${diferencia.abs().formatear()}`, dentroDeTolerancia: false }
    : { estado: 'sobrante', mensaje: `Sobrante de ${diferencia.formatear()}`, dentroDeTolerancia: false };
}

function lineaConciliada(
  base: Pick<LineaConciliada, 'clave' | 'id_metodo' | 'nombre' | 'categoria' | 'esperado'>,
  declarado: Dinero | null,
  tolerancia: Dinero,
): { linea: LineaConciliada; fueraDeTolerancia: boolean } {
  if (declarado === null) {
    return {
      linea: { ...base, declarado: null, diferencia: null, estado: 'sin_declarar', mensaje: 'Sin declarar' },
      fueraDeTolerancia: false,
    };
  }
  const diferencia = declarado.restar(base.esperado);
  const d = describirDiferencia(diferencia, tolerancia);
  return {
    linea: { ...base, declarado, diferencia, estado: d.estado, mensaje: d.mensaje },
    fueraDeTolerancia: !d.dentroDeTolerancia,
  };
}

export class Conciliador {
  /**
   * @param contado Efectivo contado (suma de denominaciones o monto contado).
   * @param declaraciones Totales que el cajero leyó en Yape, POS, banco… por medio de pago.
   * @param metodosActivos Para nombrar medios declarados que no tuvieron movimiento.
   */
  static conciliar(
    esperado: EsperadoCaja,
    contado: Dinero,
    declaraciones: readonly DeclaracionMedio[],
    metodosActivos: readonly MetodoPagoCaja[],
    tolerancia: Dinero = Dinero.CERO,
  ): ResultadoConciliacion {
    const porMetodo = new Map<number, Dinero>();
    for (const d of declaraciones) {
      if (porMetodo.has(d.id_metodo)) {
        throw ErrorCaja.datoInvalido(`El medio de pago ${d.id_metodo} está declarado dos veces.`);
      }
      if (d.declarado.esNegativo()) throw ErrorCaja.datoInvalido('Los montos declarados no pueden ser negativos.');
      porMetodo.set(d.id_metodo, d.declarado);
    }

    const efectivo = lineaConciliada(
      { clave: 'efectivo', id_metodo: null, nombre: 'Efectivo', categoria: 'efectivo', esperado: esperado.efectivo.esperado },
      contado,
      tolerancia,
    );

    const lineas: LineaMetodoEsperado[] = [...esperado.otros_medios];
    for (const idMetodo of porMetodo.keys()) {
      if (lineas.some((l) => l.id_metodo === idMetodo)) continue;
      const metodo = metodosActivos.find((m) => m.id_metodo === idMetodo);
      if (!metodo) throw ErrorCaja.datoInvalido(`El medio de pago ${idMetodo} no existe o está inactivo.`);
      const categoria = categoriaMetodo(metodo.tipo, metodo.nombre);
      if (categoria === 'efectivo') {
        throw ErrorCaja.datoInvalido(
          `${metodo.nombre} es efectivo: se registra con el conteo de la gaveta, no como medio declarado.`,
        );
      }
      if (!seConciliaPorDeclaracion(categoria)) {
        throw ErrorCaja.datoInvalido(`${metodo.nombre} no es dinero recibido: no se declara en el arqueo.`);
      }
      lineas.push({
        clave: String(idMetodo),
        id_metodo: idMetodo,
        nombre: metodo.nombre,
        categoria,
        ventas: Dinero.CERO,
        abonos: Dinero.CERO,
        esperado: Dinero.CERO,
        operaciones: 0,
      });
    }

    let fuera = efectivo.fueraDeTolerancia;
    const otros = lineas.map((l) => {
      const r = lineaConciliada(
        { clave: l.clave, id_metodo: l.id_metodo, nombre: l.nombre, categoria: l.categoria, esperado: l.esperado },
        l.id_metodo == null ? null : porMetodo.get(l.id_metodo) ?? null,
        tolerancia,
      );
      fuera = fuera || r.fueraDeTolerancia;
      return r.linea;
    });

    const partes = [efectivo.linea, ...otros]
      .filter((l) => l.estado === 'faltante' || l.estado === 'sobrante')
      .map((l, i) => {
        const texto = `${l.mensaje} en ${l.clave === 'efectivo' ? 'efectivo' : l.nombre}`;
        return i === 0 ? texto : texto.charAt(0).toLowerCase() + texto.slice(1);
      });

    return {
      efectivo: efectivo.linea,
      otros_medios: otros,
      hay_diferencia: fuera,
      resumen: partes.length ? partes.join('; ') : 'Cuadra',
    };
  }
}
