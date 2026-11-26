import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Dinero } from '../dominio/dinero';
import { categoriaMetodo } from '../dominio/metodo-pago';
import { EsquemaCajaService } from '../esquema/esquema-caja.service';

type Consultor = Pick<EntityManager, 'query'>;

/** Turno al que pertenece la venta: la misma ventana que usa el esperado (sql-esperado.ts). */
export interface TurnoDeVenta {
  id_apertura: number;
  id_usuario: number | null;
  usuario_nombre: string | null;
  caja_nombre: string;
  abierto: boolean;
}

/** Lo que la caja necesita saber de una venta para devolver efectivo (Fase 7.1). */
export interface EfectivoDeVenta {
  id_venta: number;
  estado: string;
  /** venta_pago con medio de efectivo (lo aplicado: lo recibido menos el vuelto). */
  efectivo_venta: Dinero;
  /** Abonos de su cuenta por cobrar cobrados en efectivo (cuentan en el turno de quien los cobró, siempre). */
  abonos_efectivo: Dinero;
  /** Todos los abonos de su cuenta por cobrar, en cualquier medio (7.2). */
  abonos_total: Dinero;
  /** Egresos ya enlazados a la venta; null sin sql/fase20 (no se puede saber). */
  ya_reembolsado: Dinero | null;
  turno: TurnoDeVenta | null;
}

/**
 * Lecturas de la Fase 7 sobre una venta: cuánto se cobró en efectivo, cuánto ya se devolvió desde la caja
 * y en qué turno cayó. Las columnas opcionales se leen solo si existen (EsquemaCajaService). Con `consultor`
 * corre dentro de la transacción de quien llama (el egreso relee aquí, con el candado de la venta tomado).
 */
@Injectable()
export class DevolucionCajaRepository {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  async efectivoDeVenta(idVenta: number, consultor: Consultor = this.dataSource): Promise<EfectivoDeVenta | null> {
    const s = await this.esquema.snapshot();
    const conEstado = s.tieneColumna('ventas', 'estado');
    const cabecera = await consultor.query(
      `SELECT v.id_venta, ${conEstado ? "COALESCE(v.estado, 'activa')" : "'activa'"} AS estado
         FROM ventas v
        WHERE v.id_venta = $1`,
      [idVenta],
    );
    if (!cabecera[0]) return null;

    // En serie a propósito: con `consultor` corre dentro de una transacción (una sola conexión).
    const pagos: any[] = await consultor.query(
      `SELECT vp.monto::text AS monto, mp.nombre, mp.tipo
         FROM venta_pago vp
         LEFT JOIN metodos_pago mp ON mp.id_metodo = vp.id_metodo
        WHERE vp.id_venta = $1`,
      [idVenta],
    );
    const abonos: any[] = s.tiene('credito')
      ? await consultor.query(
          `SELECT ab.monto::text AS monto, mp.nombre, mp.tipo
             FROM abonos_credito ab
             JOIN cuentas_por_cobrar c ON c.id_cxc = ab.id_cxc
             LEFT JOIN metodos_pago mp ON mp.id_metodo = ab.id_metodo
            WHERE c.id_venta = $1`,
          [idVenta],
        )
      : [];
    const reembolsado: any[] | null = s.tiene('movimientoVenta')
      ? await consultor.query(
          `SELECT COALESCE(SUM(m.monto), 0)::text AS total
             FROM movimientos_caja m
            WHERE m.id_venta = $1 AND m.tipo = 'egreso'`,
          [idVenta],
        )
      : null;
    const turno = await this.turnoDeVenta(idVenta, consultor);

    const efectivo = (filas: any[]) =>
      Dinero.sumarTodos(
        (filas ?? [])
          .filter((f) => categoriaMetodo(f.tipo, f.nombre) === 'efectivo')
          .map((f) => Dinero.desdeBd(f.monto)),
      );
    return {
      id_venta: Number(cabecera[0].id_venta),
      estado: String(cabecera[0].estado ?? 'activa'),
      efectivo_venta: efectivo(pagos),
      abonos_efectivo: efectivo(abonos),
      abonos_total: Dinero.sumarTodos(abonos.map((f) => Dinero.desdeBd(f.monto))),
      ya_reembolsado: reembolsado ? Dinero.desdeBd(reembolsado[0]?.total) : null,
      turno,
    };
  }

  /** Suma de los abonos de la venta en cualquier medio (7.2). 0 si no hay crédito en el esquema. */
  async abonosDeVenta(idVenta: number): Promise<Dinero> {
    if (!(await this.esquema.tiene('credito'))) return Dinero.CERO;
    const filas = await this.dataSource.query(
      `SELECT COALESCE(SUM(ab.monto), 0)::text AS total
         FROM abonos_credito ab
         JOIN cuentas_por_cobrar c ON c.id_cxc = ab.id_cxc
        WHERE c.id_venta = $1`,
      [idVenta],
    );
    return Dinero.desdeBd(filas[0]?.total);
  }

  /**
   * Turno cuyo esperado cuenta la venta: misma caja y `apertura ≤ venta.fecha < primer cierre` (la ventana
   * de sql-esperado.ts). null si la venta no tiene caja (caja «blanda» sin turno) o no cae en ningún turno.
   */
  async turnoDeVenta(idVenta: number, consultor: Consultor = this.dataSource): Promise<TurnoDeVenta | null> {
    const filas = await consultor.query(
      `SELECT a.id_apertura, a.id_usuario,
              NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre,
              COALESCE(c.nombre, 'Caja ' || c.id_caja::text) AS caja_nombre,
              (ci.fecha IS NULL) AS abierto
         FROM ventas v
         JOIN aperturas_caja a ON a.id_caja = v.id_caja AND v.fecha >= a.fecha
         JOIN cajas c ON c.id_caja = a.id_caja
         LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
         LEFT JOIN LATERAL (SELECT MIN(x.fecha) AS fecha FROM cierres_caja x WHERE x.id_apertura = a.id_apertura) ci ON TRUE
        WHERE v.id_venta = $1
          AND (ci.fecha IS NULL OR v.fecha < ci.fecha)
        ORDER BY a.fecha DESC, a.id_apertura DESC
        LIMIT 1`,
      [idVenta],
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_apertura: Number(f.id_apertura),
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      usuario_nombre: f.usuario_nombre ?? null,
      caja_nombre: String(f.caja_nombre),
      abierto: f.abierto === true || f.abierto === 't',
    };
  }

  /** Candado de la venta para devolver efectivo (dos devoluciones a la vez no pasan las dos). */
  async bloquearReembolso(manager: EntityManager, idVenta: number): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`caja-reembolso-venta:${idVenta}`]);
  }
}
