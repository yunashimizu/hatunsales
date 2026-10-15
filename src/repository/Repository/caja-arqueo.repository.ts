import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Dinero } from '../../caja/dominio/dinero';
import { FilaFuenteCaja, FuenteCaja } from '../../caja/dominio/esperado-caja';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import { sqlEsperadoTurno } from '../../caja/arqueo/sql-esperado';
import {
  ArqueoGuardado,
  ICajaArqueoRepository,
  MovimientoGuardado,
  NuevoArqueo,
  TurnoArqueo,
} from '../Irepository/ICajaArqueoRepository';

type Consultor = Pick<EntityManager, 'query'>;

/** Instante UTC de una columna `timestamp` sin zona que guarda hora UTC (sin depender de la TZ del proceso). */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const FUENTES = new Set<FuenteCaja>(['venta', 'abono', 'ingreso', 'egreso', 'venta_web', 'venta_anulada']);

const SELECT_ARQUEO = `SELECT q.id_arqueo, q.id_apertura, q.id_caja, q.id_usuario,
       NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre,
       q.tipo, q.fecha, q.monto_inicial::text AS monto_inicial,
       q.efectivo_esperado::text AS efectivo_esperado, q.efectivo_contado::text AS efectivo_contado,
       q.diferencia::text AS diferencia, q.resumen_metodos, q.observacion,
       q.conteo_por_denominaciones, q.id_cierre, q.creado_en`;

const SQL_DENOMINACIONES = `COALESCE((
         SELECT json_agg(json_build_object('tipo', d.tipo, 'denominacion', d.denominacion::text, 'cantidad', d.cantidad)
                         ORDER BY d.denominacion DESC)
           FROM caja_arqueo_denominaciones d
          WHERE d.id_arqueo = q.id_arqueo
       ), '[]'::json) AS denominaciones`;

function instante(valor: unknown): Date | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = valor instanceof Date ? valor : new Date(String(valor));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Datos del arqueo de caja (sql/fase11). Las escrituras van dentro de la transacción que
 * abre la capa bussnies con `transaccion()`, siempre después de bloquear la apertura.
 */
@Injectable()
export class CajaArqueoRepository implements ICajaArqueoRepository {
  private readonly log = new Logger(CajaArqueoRepository.name);
  private savepoints = 0;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  transaccion<T>(trabajo: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(trabajo);
  }

  async conSavepoint<T>(manager: EntityManager, trabajo: () => Promise<T>): Promise<T | null> {
    const nombre = `sp_caja_${(this.savepoints = (this.savepoints + 1) % 1_000_000)}`;
    await manager.query(`SAVEPOINT ${nombre}`);
    try {
      const resultado = await trabajo();
      await manager.query(`RELEASE SAVEPOINT ${nombre}`);
      return resultado;
    } catch (error) {
      await manager.query(`ROLLBACK TO SAVEPOINT ${nombre}`);
      this.log.warn(`Cálculo opcional de caja omitido: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  async turno(idApertura: number, manager?: EntityManager): Promise<TurnoArqueo | null> {
    const q: Consultor = manager ?? this.dataSource;
    const filas = await q.query(
      `SELECT a.id_apertura, a.id_caja,
              COALESCE(c.nombre, 'Caja ' || c.id_caja::text) AS caja_nombre,
              s.nombre AS sucursal_nombre,
              a.id_usuario,
              NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre,
              to_char(a.fecha, ${ISO_UTC}) AS fecha_apertura,
              COALESCE(a.monto_inicial, 0)::text AS monto_inicial,
              ci.id_cierre,
              to_char(ci.fecha, ${ISO_UTC}) AS fecha_cierre
         FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
         LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal
         LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
         LEFT JOIN LATERAL (
                SELECT id_cierre, fecha FROM cierres_caja
                 WHERE id_apertura = a.id_apertura
                 ORDER BY fecha ASC NULLS LAST, id_cierre ASC
                 LIMIT 1
              ) ci ON TRUE
        WHERE a.id_apertura = $1`,
      [idApertura],
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_apertura: Number(f.id_apertura),
      id_caja: Number(f.id_caja),
      caja_nombre: String(f.caja_nombre),
      sucursal_nombre: f.sucursal_nombre ?? null,
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      usuario_nombre: f.usuario_nombre ?? null,
      fecha_apertura: instante(f.fecha_apertura),
      monto_inicial: Dinero.desdeBd(f.monto_inicial),
      abierta: f.id_cierre == null,
      id_cierre: f.id_cierre != null ? Number(f.id_cierre) : null,
      fecha_cierre: instante(f.fecha_cierre),
    };
  }

  async filasEsperado(idApertura: number, manager?: EntityManager): Promise<FilaFuenteCaja[]> {
    const s = await this.esquema.snapshot();
    const sql = sqlEsperadoTurno({
      conAbonos: s.tiene('credito'),
      movimientosPorTurno: s.tiene('movimientosPorTurno'),
      conEstado: s.tieneColumna('ventas', 'estado'),
      conOrigen: s.tieneColumna('ventas', 'origen'),
    });
    const q: Consultor = manager ?? this.dataSource;
    const filas: any[] = await q.query(sql, [idApertura]);
    return filas
      .filter((f) => FUENTES.has(f.fuente))
      .map((f) => ({
        fuente: f.fuente as FuenteCaja,
        id_metodo: f.id_metodo != null ? Number(f.id_metodo) : null,
        nombre: f.nombre ?? null,
        tipo: f.tipo ?? null,
        total: Dinero.desdeBd(f.total),
        cantidad: Number(f.cantidad ?? 0),
        vuelto: Dinero.desdeBd(f.vuelto),
      }));
  }

  async insertar(manager: EntityManager, a: NuevoArqueo): Promise<number> {
    const filas = await manager.query(
      `INSERT INTO caja_arqueos
         (id_apertura, id_caja, id_usuario, tipo, fecha, monto_inicial, efectivo_esperado,
          efectivo_contado, diferencia, resumen_metodos, observacion, conteo_por_denominaciones,
          clave_idempotencia)
       VALUES ($1, $2, $3, $4, NOW(), $5::numeric, $6::numeric, $7::numeric, $8::numeric,
               $9::jsonb, $10, $11, $12)
       RETURNING id_arqueo`,
      [
        a.id_apertura,
        a.id_caja,
        a.id_usuario,
        a.tipo,
        a.monto_inicial.aTexto(),
        a.efectivo_esperado.aTexto(),
        a.efectivo_contado.aTexto(),
        a.diferencia.aTexto(),
        JSON.stringify(a.resumen_metodos),
        a.observacion,
        a.conteo_por_denominaciones,
        a.clave_idempotencia,
      ],
    );
    const idArqueo = Number(filas[0]?.id_arqueo);

    if (a.denominaciones.length) {
      await manager.query(
        `INSERT INTO caja_arqueo_denominaciones (id_arqueo, tipo, denominacion, cantidad, subtotal)
         SELECT $1, d.tipo, d.denominacion, d.cantidad, d.subtotal
           FROM unnest($2::text[], $3::numeric[], $4::int[], $5::numeric[]) AS d(tipo, denominacion, cantidad, subtotal)`,
        [
          idArqueo,
          a.denominaciones.map((d) => d.tipo),
          a.denominaciones.map((d) => d.denominacion.aTexto()),
          a.denominaciones.map((d) => d.cantidad),
          a.denominaciones.map((d) => d.subtotal.aTexto()),
        ],
      );
    }
    return idArqueo;
  }

  async buscarPorClave(clave: string, manager?: EntityManager): Promise<number | null> {
    const q: Consultor = manager ?? this.dataSource;
    const filas = await q.query(`SELECT id_arqueo FROM caja_arqueos WHERE clave_idempotencia = $1 LIMIT 1`, [clave]);
    return filas[0]?.id_arqueo != null ? Number(filas[0].id_arqueo) : null;
  }

  async obtener(idArqueo: number, manager?: EntityManager): Promise<ArqueoGuardado | null> {
    const q: Consultor = manager ?? this.dataSource;
    const filas = await q.query(
      `${SELECT_ARQUEO},
       ${SQL_DENOMINACIONES}
         FROM caja_arqueos q
         LEFT JOIN usuarios u ON u.id_usuario = q.id_usuario
        WHERE q.id_arqueo = $1`,
      [idArqueo],
    );
    return filas[0] ? this.mapArqueo(filas[0]) : null;
  }

  async listarPorTurno(idApertura: number, limite: number): Promise<ArqueoGuardado[]> {
    const filas = await this.dataSource.query(
      `${SELECT_ARQUEO},
       '[]'::json AS denominaciones
         FROM caja_arqueos q
         LEFT JOIN usuarios u ON u.id_usuario = q.id_usuario
        WHERE q.id_apertura = $1
        ORDER BY q.id_arqueo DESC
        LIMIT $2`,
      [idApertura, limite],
    );
    return filas.map((f: any) => this.mapArqueo(f));
  }

  async ultimoDeCierre(manager: EntityManager, idApertura: number): Promise<ArqueoGuardado | null> {
    const filas = await manager.query(
      `${SELECT_ARQUEO},
       ${SQL_DENOMINACIONES}
         FROM caja_arqueos q
         LEFT JOIN usuarios u ON u.id_usuario = q.id_usuario
        WHERE q.id_apertura = $1 AND q.tipo = 'cierre'
        ORDER BY q.id_arqueo DESC
        LIMIT 1`,
      [idApertura],
    );
    return filas[0] ? this.mapArqueo(filas[0]) : null;
  }

  async vincularCierre(manager: EntityManager, idArqueo: number, idCierre: number): Promise<void> {
    await manager.query(`UPDATE caja_arqueos SET id_cierre = $2 WHERE id_arqueo = $1`, [idArqueo, idCierre]);
  }

  async registrarMovimiento(
    manager: EntityManager,
    d: { id_apertura: number; id_caja: number; id_usuario: number; tipo: 'ingreso' | 'egreso'; monto: Dinero; descripcion: string },
  ): Promise<number> {
    const filas = await manager.query(
      `INSERT INTO movimientos_caja (id_caja, tipo, monto, descripcion, fecha, id_apertura, id_usuario)
       VALUES ($1, $2, $3::numeric, $4, NOW(), $5, $6)
       RETURNING id_movimiento`,
      [d.id_caja, d.tipo, d.monto.aTexto(), d.descripcion, d.id_apertura, d.id_usuario],
    );
    return Number(filas[0]?.id_movimiento);
  }

  async listarMovimientos(idApertura: number, limite: number): Promise<MovimientoGuardado[]> {
    const filas = await this.dataSource.query(
      `SELECT m.id_movimiento, m.id_apertura, m.id_caja, m.tipo::text AS tipo, m.monto::text AS monto,
              COALESCE(m.descripcion, '') AS descripcion,
              to_char(m.fecha, ${ISO_UTC}) AS fecha,
              m.id_usuario,
              NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre
         FROM aperturas_caja a
         LEFT JOIN LATERAL (
                SELECT MIN(ci.fecha) AS fecha FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              ) ci ON TRUE
         JOIN movimientos_caja m
           ON m.id_apertura = a.id_apertura
           OR (m.id_apertura IS NULL AND m.id_caja = a.id_caja AND m.fecha >= a.fecha
               AND (ci.fecha IS NULL OR m.fecha < ci.fecha))
         LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
        WHERE a.id_apertura = $1
        ORDER BY m.fecha DESC, m.id_movimiento DESC
        LIMIT $2`,
      [idApertura, limite],
    );
    return filas.map((f: any) => ({
      id_movimiento: Number(f.id_movimiento),
      id_apertura: f.id_apertura != null ? Number(f.id_apertura) : null,
      id_caja: Number(f.id_caja),
      tipo: f.tipo === 'egreso' ? 'egreso' : 'ingreso',
      monto: Dinero.desdeBd(f.monto),
      descripcion: String(f.descripcion ?? ''),
      fecha: instante(f.fecha) ?? new Date(0),
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      usuario_nombre: f.usuario_nombre ?? null,
    }));
  }

  private mapArqueo(f: any): ArqueoGuardado {
    const resumen = typeof f.resumen_metodos === 'string' ? JSON.parse(f.resumen_metodos) : f.resumen_metodos;
    const denominaciones = typeof f.denominaciones === 'string' ? JSON.parse(f.denominaciones) : f.denominaciones;
    return {
      id_arqueo: Number(f.id_arqueo),
      id_apertura: Number(f.id_apertura),
      id_caja: f.id_caja != null ? Number(f.id_caja) : null,
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      usuario_nombre: f.usuario_nombre ?? null,
      tipo: f.tipo === 'cierre' ? 'cierre' : 'parcial',
      fecha: instante(f.fecha) ?? new Date(0),
      monto_inicial: Dinero.desdeBd(f.monto_inicial),
      efectivo_esperado: Dinero.desdeBd(f.efectivo_esperado),
      efectivo_contado: Dinero.desdeBd(f.efectivo_contado),
      diferencia: Dinero.desdeBd(f.diferencia),
      resumen_metodos: resumen && typeof resumen === 'object' ? resumen : {},
      observacion: f.observacion ?? null,
      conteo_por_denominaciones: f.conteo_por_denominaciones !== false,
      id_cierre: f.id_cierre != null ? Number(f.id_cierre) : null,
      creado_en: instante(f.creado_en) ?? new Date(0),
      denominaciones: Array.isArray(denominaciones)
        ? denominaciones.map((d: any) => ({ tipo: String(d.tipo), denominacion: String(d.denominacion), cantidad: Number(d.cantidad) }))
        : [],
    };
  }
}
