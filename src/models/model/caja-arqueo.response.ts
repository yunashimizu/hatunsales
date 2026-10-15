/**
 * Respuestas del arqueo de caja. Todos los montos son soles con 2 decimales como número JSON
 * (calculados en céntimos enteros en el servidor). Fechas en ISO 8601 UTC.
 */
import type { CategoriaMetodo } from '../../caja/dominio/metodo-pago';
import type { EstadoConciliacion } from '../../caja/dominio/conciliacion';

export interface TurnoArqueoResponse {
  id_apertura: number;
  id_caja: number;
  caja_nombre: string;
  sucursal_nombre: string | null;
  /** Dueño del turno (quien abrió la caja). */
  id_usuario: number | null;
  usuario_nombre: string | null;
  fecha_apertura: string | null;
  monto_inicial: number;
  abierta: boolean;
  fecha_cierre: string | null;
}

export interface MetodoEsperadoResponse {
  clave: string;
  id_metodo: number | null;
  nombre: string;
  categoria: CategoriaMetodo;
  ventas: number;
  abonos: number;
  esperado: number;
  operaciones: number;
}

export interface EfectivoEsperadoResponse {
  monto_inicial: number;
  ventas: number;
  abonos: number;
  ingresos: number;
  egresos: number;
  /** Informativo: ya está descontado de `ventas` (venta_pago.monto es lo aplicado). */
  vueltos_entregados: number;
  esperado: number;
  operaciones_ventas: number;
  operaciones_abonos: number;
  cantidad_ingresos: number;
  cantidad_egresos: number;
  metodos: MetodoEsperadoResponse[];
}

export interface DenominacionValidaResponse {
  tipo: 'billete' | 'moneda';
  denominacion: number;
  etiqueta: string;
}

export interface MedioDeclarableResponse {
  id_metodo: number;
  nombre: string;
  categoria: CategoriaMetodo;
}

export interface ArqueoResumenResponse {
  id_arqueo: number;
  codigo: string;
  tipo: 'parcial' | 'cierre';
  fecha: string;
  id_apertura: number;
  id_usuario: number | null;
  usuario_nombre: string | null;
  efectivo_esperado: number;
  efectivo_contado: number;
  diferencia: number;
  estado: Exclude<EstadoConciliacion, 'sin_declarar'>;
  mensaje: string;
  hay_diferencia: boolean;
  id_cierre: number | null;
}

/** GET /caja/arqueo/esperado */
export interface ArqueoEsperadoResponse {
  apertura: TurnoArqueoResponse;
  efectivo: EfectivoEsperadoResponse;
  otros_medios: MetodoEsperadoResponse[];
  credito: { ventas: number; operaciones: number };
  ventas_web: { total: number; cantidad: number };
  ventas_anuladas: { total: number; cantidad: number };
  total_cobrado: number;
  denominaciones: DenominacionValidaResponse[];
  medios_declarables: MedioDeclarableResponse[];
  /** Diferencias de hasta este monto se consideran "cuadra" (configuraciones.caja_arqueo_tolerancia). */
  tolerancia: number;
  ultimo_arqueo: ArqueoResumenResponse | null;
  generado_en: string;
}

export interface DenominacionContadaResponse {
  tipo: 'billete' | 'moneda';
  denominacion: number;
  etiqueta: string;
  cantidad: number;
  subtotal: number;
}

export interface MedioConciliadoResponse {
  clave: string;
  id_metodo: number | null;
  nombre: string;
  categoria: CategoriaMetodo;
  esperado: number;
  declarado: number | null;
  diferencia: number | null;
  estado: EstadoConciliacion;
  mensaje: string;
}

/** POST /caja/arqueo y GET /caja/arqueo/:id */
export interface ArqueoDetalleResponse extends ArqueoResumenResponse {
  id_caja: number | null;
  caja_nombre: string;
  sucursal_nombre: string | null;
  /** Dueño del turno. */
  cajero_id: number | null;
  cajero_nombre: string | null;
  fecha_apertura: string | null;
  turno_abierto: boolean;
  monto_inicial: number;
  /** Desglose del efectivo esperado al momento del arqueo. */
  efectivo: Omit<EfectivoEsperadoResponse, 'metodos'>;
  conteo_por_denominaciones: boolean;
  denominaciones: DenominacionContadaResponse[];
  total_billetes: number;
  total_monedas: number;
  medios: MedioConciliadoResponse[];
  credito: { ventas: number; operaciones: number };
  ventas_web: { total: number; cantidad: number };
  ventas_anuladas: { total: number; cantidad: number };
  tolerancia: number;
  resumen: string;
  observacion: string | null;
  creado_en: string;
  /** true si el POST devolvió un arqueo ya registrado con la misma clave_idempotencia. */
  idempotente?: boolean;
}

/** POST /caja/movimientos y GET /caja/movimientos */
export interface MovimientoCajaResponse {
  id_movimiento: number;
  id_apertura: number | null;
  id_caja: number;
  tipo: 'ingreso' | 'egreso';
  monto: number;
  descripcion: string;
  fecha: string;
  id_usuario: number | null;
  usuario_nombre: string | null;
}

export interface MovimientosTurnoResponse {
  apertura: TurnoArqueoResponse;
  items: MovimientoCajaResponse[];
  total_ingresos: number;
  total_egresos: number;
}
