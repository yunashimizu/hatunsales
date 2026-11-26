import type {
  ArqueoEsperadoResponse,
  EfectivoEsperadoResponse,
  MetodoEsperadoResponse,
} from '../../models/model/caja-arqueo.response';
import type { ResumenTurno } from '../../repository/Repository/caja-sesion.repository';

/**
 * Arqueo ciego (Fase 7.3, D4). Utilidad pura: qué montos se anulan (null) cuando la clave `arqueo_ciego` está
 * encendida y quien pregunta no es admin. Se ocultan los montos de los que se deduce el efectivo esperado
 * (ventas y abonos por medio, esperado, total cobrado); se conservan los que el cajero ya conoce (monto
 * inicial, ingresos, egresos) y los conteos de operaciones. Con la clave apagada nada de esto se usa.
 */

type ConNulos<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

export type MetodoEsperadoCiego = ConNulos<MetodoEsperadoResponse, 'ventas' | 'abonos' | 'esperado'>;

export type EfectivoEsperadoCiego = ConNulos<
  Omit<EfectivoEsperadoResponse, 'metodos'>,
  'ventas' | 'abonos' | 'vueltos_entregados' | 'esperado'
> & { metodos: MetodoEsperadoCiego[] };

/** GET caja/arqueo/esperado: siempre trae las dos marcas; con el esperado oculto, los montos van en null. */
export type ArqueoEsperadoConMarca = (ArqueoEsperadoResponse | ArqueoEsperadoCiego) & {
  /** Fase 7.3: la clave `arqueo_ciego` está encendida. */
  arqueo_ciego: boolean;
  /** true = este usuario no ve el esperado hasta enviar su conteo (POST caja/arqueo lo devuelve). */
  esperado_oculto: boolean;
};

export type ArqueoEsperadoCiego = Omit<ArqueoEsperadoResponse, 'efectivo' | 'otros_medios' | 'total_cobrado'> & {
  efectivo: EfectivoEsperadoCiego;
  otros_medios: MetodoEsperadoCiego[];
  total_cobrado: number | null;
};

function metodoCiego(m: MetodoEsperadoResponse): MetodoEsperadoCiego {
  return { ...m, ventas: null, abonos: null, esperado: null };
}

export function esperadoCiego(r: ArqueoEsperadoResponse): ArqueoEsperadoCiego {
  return {
    ...r,
    efectivo: {
      ...r.efectivo,
      ventas: null,
      abonos: null,
      vueltos_entregados: null,
      esperado: null,
      metodos: r.efectivo.metodos.map(metodoCiego),
    },
    otros_medios: r.otros_medios.map(metodoCiego),
    total_cobrado: null,
  };
}

/** Resumen del turno (GET caja/sesion, GET caja/turno-resumen, POST caja/cerrar) con los montos ocultos. */
export interface ResumenTurnoCiego {
  ventas: number;
  total: number | null;
  por_metodo: { metodo: string; total: number | null; cantidad: number }[];
}

export function resumenTurnoCiego(r: ResumenTurno): ResumenTurnoCiego {
  return {
    ventas: r.ventas,
    total: null,
    por_metodo: r.por_metodo.map((m) => ({ ...m, total: null })),
  };
}

/** Texto genérico para mensajes que hoy citan el esperado (egreso que excede, arqueo desactualizado, aviso del cierre). */
export const MENSAJE_ESPERADO_OCULTO = 'el efectivo esperado no se muestra hasta registrar el conteo (arqueo ciego)';
