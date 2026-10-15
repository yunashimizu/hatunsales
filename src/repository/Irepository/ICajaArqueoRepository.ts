import type { EntityManager } from 'typeorm';
import type { Dinero } from '../../caja/dominio/dinero';
import type { FilaFuenteCaja } from '../../caja/dominio/esperado-caja';
import type { LineaConteo } from '../../caja/dominio/denominaciones';

/** Turno (apertura) visto por el arqueo, con fechas como instantes UTC. */
export interface TurnoArqueo {
  id_apertura: number;
  id_caja: number;
  caja_nombre: string;
  sucursal_nombre: string | null;
  id_usuario: number | null;
  usuario_nombre: string | null;
  fecha_apertura: Date | null;
  monto_inicial: Dinero;
  abierta: boolean;
  id_cierre: number | null;
  fecha_cierre: Date | null;
}

export interface ArqueoGuardado {
  id_arqueo: number;
  id_apertura: number;
  id_caja: number | null;
  id_usuario: number | null;
  usuario_nombre: string | null;
  tipo: 'parcial' | 'cierre';
  fecha: Date;
  monto_inicial: Dinero;
  efectivo_esperado: Dinero;
  efectivo_contado: Dinero;
  diferencia: Dinero;
  resumen_metodos: Record<string, any>;
  observacion: string | null;
  conteo_por_denominaciones: boolean;
  id_cierre: number | null;
  creado_en: Date;
  denominaciones: { tipo: string; denominacion: string; cantidad: number }[];
}

export interface NuevoArqueo {
  id_apertura: number;
  id_caja: number | null;
  id_usuario: number | null;
  tipo: 'parcial' | 'cierre';
  monto_inicial: Dinero;
  efectivo_esperado: Dinero;
  efectivo_contado: Dinero;
  diferencia: Dinero;
  resumen_metodos: Record<string, unknown>;
  observacion: string | null;
  conteo_por_denominaciones: boolean;
  clave_idempotencia: string | null;
  denominaciones: readonly LineaConteo[];
}

export interface MovimientoGuardado {
  id_movimiento: number;
  id_apertura: number | null;
  id_caja: number;
  tipo: 'ingreso' | 'egreso';
  monto: Dinero;
  descripcion: string;
  fecha: Date;
  id_usuario: number | null;
  usuario_nombre: string | null;
}

export interface ICajaArqueoRepository {
  transaccion<T>(trabajo: (manager: EntityManager) => Promise<T>): Promise<T>;
  /** Ejecuta `trabajo` dentro de un SAVEPOINT: si falla, deshace solo eso y devuelve null. */
  conSavepoint<T>(manager: EntityManager, trabajo: () => Promise<T>): Promise<T | null>;
  turno(idApertura: number, manager?: EntityManager): Promise<TurnoArqueo | null>;
  /** Movimientos del turno agregados por fuente y medio de pago (una sola consulta). */
  filasEsperado(idApertura: number, manager?: EntityManager): Promise<FilaFuenteCaja[]>;
  insertar(manager: EntityManager, arqueo: NuevoArqueo): Promise<number>;
  buscarPorClave(clave: string, manager?: EntityManager): Promise<number | null>;
  obtener(idArqueo: number, manager?: EntityManager): Promise<ArqueoGuardado | null>;
  listarPorTurno(idApertura: number, limite: number): Promise<ArqueoGuardado[]>;
  ultimoDeCierre(manager: EntityManager, idApertura: number): Promise<ArqueoGuardado | null>;
  vincularCierre(manager: EntityManager, idArqueo: number, idCierre: number): Promise<void>;
  registrarMovimiento(
    manager: EntityManager,
    datos: { id_apertura: number; id_caja: number; id_usuario: number; tipo: 'ingreso' | 'egreso'; monto: Dinero; descripcion: string },
  ): Promise<number>;
  listarMovimientos(idApertura: number, limite: number): Promise<MovimientoGuardado[]>;
}
