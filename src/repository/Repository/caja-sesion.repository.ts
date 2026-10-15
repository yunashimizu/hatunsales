import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ConfiguracionRepository } from './configuracion.repository';
import { EsquemaCajaService, SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { Dinero } from '../../caja/dominio/dinero';

export type AperturaSesion = {
  id_apertura: number;
  id_caja: number;
  caja_nombre: string;
  id_sucursal: number | null;
  sucursal_nombre: string | null;
  id_usuario: number | null;
  fecha: string | null;
  monto_inicial: number | null;
};

export type CajaDisponible = {
  id_caja: number;
  nombre: string;
  id_sucursal: number | null;
  sucursal_nombre: string | null;
  ocupada: boolean;
};

export type ResumenTurno = {
  ventas: number;
  total: number;
  por_metodo: { metodo: string; total: number; cantidad: number }[];
};

/** Lo que el arqueo de cierre (u otro llamador) aporta al cierre, dentro de su transacción. */
export interface PreparacionCierre {
  /** Si viene, reemplaza el monto contado del cuerpo. */
  montoConteo?: number | null;
  observacion?: string | null;
  /** Efectivo esperado por el sistema → cierres_caja.monto_final (texto NUMERIC). */
  montoFinal?: string | null;
  /** Se ejecuta tras insertar el cierre (p. ej. enlazar el arqueo). */
  alCerrar?: (manager: EntityManager, idCierre: number) => Promise<void>;
}

export interface ResultadoCierre {
  id_apertura: number;
  id_cierre: number | null;
  cerrada: boolean;
  monto_conteo: number | null;
}

type MetaApertura = { colFecha: string | null; colMonto: string | null };
type MetaCierre = {
  colFecha: string | null;
  colMonto: string | null;
  colObs: string | null;
  tieneIdUsuario: boolean;
  tieneMontoFinal: boolean;
};
type MetaCaja = { exprNombre: string; tieneSucursal: boolean };

interface MetaSesion {
  snapshot: SnapshotEsquema;
  apertura: MetaApertura;
  cierre: MetaCierre;
  caja: MetaCaja;
}

const CANDADO_APERTURA_USUARIO = 'caja:apertura:usuario:';

/**
 * Sesión de caja (apertura / cierre).
 *
 * Descubre las columnas reales (para no romper esquemas antiguos) leyendo el catálogo una
 * sola vez (EsquemaCajaService) y nunca ejecuta DDL. GET /caja/sesion hace 1-2 consultas.
 */
@Injectable()
export class CajaSesionRepository {
  private readonly log = new Logger(CajaSesionRepository.name);
  private meta: MetaSesion | null = null;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
    private readonly config: ConfiguracionRepository,
  ) {}

  /** Metadatos derivados del catálogo; se recalculan solo si el catálogo se releyó. */
  private async metaSesion(): Promise<MetaSesion> {
    const snapshot = await this.esquema.snapshot();
    if (this.meta?.snapshot === snapshot) return this.meta;

    const colsAp = snapshot.columnas('aperturas_caja');
    const colsCi = snapshot.columnas('cierres_caja');
    const colsCaja = snapshot.columnas('cajas');
    const primera = (cols: ReadonlySet<string>, candidatas: string[]) => candidatas.find((c) => cols.has(c)) ?? null;

    this.meta = {
      snapshot,
      apertura: {
        colFecha: primera(colsAp, ['fecha', 'fecha_apertura', 'abierto_en', 'created_at']),
        colMonto: primera(colsAp, ['monto_inicial', 'saldo_inicial', 'monto_apertura', 'monto']),
      },
      cierre: {
        colFecha: primera(colsCi, ['fecha', 'fecha_cierre', 'cerrado_en', 'created_at']),
        colMonto: primera(colsCi, ['monto_conteo', 'monto_cierre', 'saldo_final']),
        colObs: primera(colsCi, ['observacion', 'observaciones', 'nota', 'comentario']),
        tieneIdUsuario: colsCi.has('id_usuario'),
        tieneMontoFinal: colsCi.has('monto_final'),
      },
      caja: {
        exprNombre: colsCaja.has('nombre')
          ? `COALESCE(c.nombre, 'Caja ' || c.id_caja::text)`
          : colsCaja.has('descripcion')
            ? `COALESCE(c.descripcion, 'Caja ' || c.id_caja::text)`
            : `'Caja ' || c.id_caja::text`,
        tieneSucursal: colsCaja.has('id_sucursal'),
      },
    };
    return this.meta;
  }

  /** caja_modo (configuraciones, caché de 60 s). */
  async modoCaja(): Promise<'blando' | 'estricto'> {
    const v = (await this.config.obtenerTexto('caja_modo', 'blando')).trim().toLowerCase();
    return v === 'estricto' ? 'estricto' : 'blando';
  }

  async bypassAdminEstricto(): Promise<boolean> {
    return this.config.obtenerBooleano('caja_estricto_bypass_admin', false);
  }

  /** SELECT de una apertura con su caja y sucursal (las columnas dependen del esquema). */
  private selectApertura(m: MetaSesion): { campos: string; joins: string } {
    const selFecha = m.apertura.colFecha ? `a.${m.apertura.colFecha}` : 'NULL';
    const selMonto = m.apertura.colMonto ? `a.${m.apertura.colMonto}` : 'NULL';
    const selSuc = m.caja.tieneSucursal
      ? 'c.id_sucursal, s.nombre AS sucursal_nombre'
      : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre';
    return {
      campos: `a.id_apertura,
              a.id_caja,
              ${m.caja.exprNombre} AS caja_nombre,
              ${selSuc},
              a.id_usuario,
              ${selFecha} AS fecha,
              ${selMonto} AS monto_inicial`,
      joins: `JOIN cajas c ON c.id_caja = a.id_caja
         ${m.caja.tieneSucursal ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal' : ''}`,
    };
  }

  async sesionUsuario(idUsuario: number): Promise<AperturaSesion | null> {
    const m = await this.metaSesion();
    const { campos, joins } = this.selectApertura(m);
    const orden = m.apertura.colFecha ? `a.${m.apertura.colFecha} DESC, a.id_apertura DESC` : 'a.id_apertura DESC';
    const filas = await this.dataSource.query(
      `SELECT ${campos}
         FROM aperturas_caja a
         ${joins}
        WHERE a.id_usuario = $1
          AND NOT EXISTS (
                SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              )
        ORDER BY ${orden}
        LIMIT 1`,
      [idUsuario],
    );
    return filas[0] ? this.mapApertura(filas[0]) : null;
  }

  async tieneAperturaAbiertaUsuario(idUsuario: number, manager?: EntityManager): Promise<boolean> {
    const q = manager ?? this.dataSource;
    const filas = await q.query(
      `SELECT 1
         FROM aperturas_caja a
        WHERE a.id_usuario = $1
          AND NOT EXISTS (
                SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              )
        LIMIT 1`,
      [idUsuario],
    );
    return filas.length > 0;
  }

  async cajaOcupada(idCaja: number, manager?: EntityManager): Promise<boolean> {
    const q = manager ?? this.dataSource;
    const filas = await q.query(
      `SELECT 1
         FROM aperturas_caja a
        WHERE a.id_caja = $1
          AND NOT EXISTS (
                SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              )
        LIMIT 1`,
      [idCaja],
    );
    return filas.length > 0;
  }

  async cajaExiste(idCaja: number): Promise<boolean> {
    const filas = await this.dataSource.query(
      `SELECT 1 FROM cajas WHERE id_caja = $1 LIMIT 1`,
      [idCaja],
    );
    return filas.length > 0;
  }

  async listarDisponibles(): Promise<CajaDisponible[]> {
    const m = await this.metaSesion();
    const filas = await this.dataSource.query(
      `SELECT c.id_caja,
              ${m.caja.exprNombre} AS nombre,
              ${m.caja.tieneSucursal ? 'c.id_sucursal, s.nombre AS sucursal_nombre' : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre'},
              EXISTS (
                SELECT 1 FROM aperturas_caja a
                 WHERE a.id_caja = c.id_caja
                   AND NOT EXISTS (
                         SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
                       )
              ) AS ocupada
         FROM cajas c
         ${m.caja.tieneSucursal ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal' : ''}
        ORDER BY c.id_caja ASC`,
    );

    return (filas as any[]).map((f) => ({
      id_caja: Number(f.id_caja),
      nombre: String(f.nombre ?? `Caja ${f.id_caja}`),
      id_sucursal: f.id_sucursal != null ? Number(f.id_sucursal) : null,
      sucursal_nombre: f.sucursal_nombre != null ? String(f.sucursal_nombre) : null,
      ocupada: f.ocupada === true || f.ocupada === 't' || f.ocupada === 1,
    }));
  }

  /**
   * Abre el turno. Candados en orden fijo: usuario (consultivo) → fila de la caja. Así ni el
   * mismo usuario abre dos cajas a la vez ni dos usuarios abren la misma caja.
   */
  async abrir(params: {
    idCaja: number;
    idUsuario: number;
    montoInicial?: number | null;
  }): Promise<AperturaSesion> {
    const m = await this.metaSesion();

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${CANDADO_APERTURA_USUARIO}${params.idUsuario}`,
      ]);
      await manager.query(`SELECT id_caja FROM cajas WHERE id_caja = $1 FOR UPDATE`, [params.idCaja]);

      if (await this.tieneAperturaAbiertaUsuario(params.idUsuario, manager)) {
        throw new Error('CAJA_YA_ABIERTA_USUARIO');
      }
      if (await this.cajaOcupada(params.idCaja, manager)) {
        throw new Error('CAJA_OCUPADA');
      }

      const cols = ['id_caja', 'id_usuario'];
      const vals: unknown[] = [params.idCaja, params.idUsuario];
      if (m.apertura.colMonto && params.montoInicial != null && Number.isFinite(Number(params.montoInicial))) {
        cols.push(m.apertura.colMonto);
        vals.push(Dinero.desdeNumeroRedondeado(Number(params.montoInicial)).aTexto());
      }
      const placeholders = vals.map((_, i) => `$${i + 1}`);
      // La fecha la pone la BD (NOW()), igual que ventas.fecha: el turno y sus ventas
      // se comparan con el mismo reloj.
      if (m.apertura.colFecha) {
        cols.push(m.apertura.colFecha);
        placeholders.push('NOW()');
      }

      const insertadas = await manager.query(
        `INSERT INTO aperturas_caja (${cols.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING id_apertura`,
        vals,
      );

      const idApertura = Number(insertadas[0]?.id_apertura);
      const sesion = await this.obtenerAperturaPorId(idApertura, manager);
      if (!sesion) throw new Error('CAJA_APERTURA_NO_ENCONTRADA');
      return sesion;
    });
  }

  async obtenerAperturaPorId(
    idApertura: number,
    manager?: EntityManager,
  ): Promise<AperturaSesion | null> {
    const q = manager ?? this.dataSource;
    const m = await this.metaSesion();
    const { campos, joins } = this.selectApertura(m);
    const filas = await q.query(
      `SELECT ${campos}
         FROM aperturas_caja a
         ${joins}
        WHERE a.id_apertura = $1
        LIMIT 1`,
      [idApertura],
    );
    return filas[0] ? this.mapApertura(filas[0]) : null;
  }

  /**
   * Bloquea la fila de la apertura (FOR UPDATE). Cierre, arqueo e ingresos/egresos del turno
   * toman este mismo candado primero, así no se cruzan entre sí.
   */
  async bloquearApertura(manager: EntityManager, idApertura: number): Promise<boolean> {
    const filas = await manager.query(
      `SELECT id_apertura FROM aperturas_caja WHERE id_apertura = $1 FOR UPDATE`,
      [idApertura],
    );
    return filas.length > 0;
  }

  async estaCerrada(idApertura: number, manager?: EntityManager): Promise<boolean> {
    const q = manager ?? this.dataSource;
    const filas = await q.query(
      `SELECT 1 FROM cierres_caja WHERE id_apertura = $1 LIMIT 1`,
      [idApertura],
    );
    return filas.length > 0;
  }

  /**
   * Cierra el turno en una transacción: bloquea la apertura, verifica que siga abierta,
   * deja que `preparar` (el arqueo de cierre) complete los datos y registra el cierre.
   */
  async cerrar(
    params: {
      idApertura: number;
      idUsuario: number;
      montoConteo?: number | null;
      observacion?: string | null;
    },
    preparar?: (manager: EntityManager) => Promise<PreparacionCierre>,
  ): Promise<ResultadoCierre> {
    const m = await this.metaSesion();

    return this.dataSource.transaction(async (manager) => {
      if (!(await this.bloquearApertura(manager, params.idApertura))) {
        throw new Error('CAJA_APERTURA_NO_ENCONTRADA');
      }
      if (await this.estaCerrada(params.idApertura, manager)) {
        throw new Error('CAJA_YA_CERRADA');
      }

      const prep: PreparacionCierre = preparar ? await preparar(manager) : {};
      const montoConteo = prep.montoConteo !== undefined ? prep.montoConteo : params.montoConteo;
      const observacion = prep.observacion !== undefined && prep.observacion !== null && String(prep.observacion).trim()
        ? prep.observacion
        : params.observacion;
      const conteoValido = montoConteo != null && Number.isFinite(Number(montoConteo));

      const cols = ['id_apertura'];
      const vals: unknown[] = [params.idApertura];
      if (m.cierre.tieneIdUsuario) {
        cols.push('id_usuario');
        vals.push(params.idUsuario);
      }
      if (m.cierre.colMonto && conteoValido) {
        cols.push(m.cierre.colMonto);
        vals.push(Dinero.desdeNumeroRedondeado(Number(montoConteo)).aTexto());
      }
      if (m.cierre.colObs && observacion != null && String(observacion).trim()) {
        cols.push(m.cierre.colObs);
        vals.push(String(observacion).trim().slice(0, 500));
      }
      if (m.cierre.tieneMontoFinal && prep.montoFinal != null) {
        cols.push('monto_final');
        vals.push(prep.montoFinal);
      }
      const placeholders = vals.map((_, i) => `$${i + 1}`);
      if (m.cierre.colFecha) {
        cols.push(m.cierre.colFecha);
        placeholders.push('NOW()');
      }

      let idCierre: number | null = null;
      try {
        const insertadas = await manager.query(
          `INSERT INTO cierres_caja (${cols.join(', ')})
           VALUES (${placeholders.join(', ')})
           RETURNING *`,
          vals,
        );
        const row = insertadas[0] ?? {};
        idCierre = row.id_cierre != null ? Number(row.id_cierre) : row.id != null ? Number(row.id) : null;
      } catch (e) {
        this.log.error(`Error al insertar cierre: ${String((e as Error)?.message ?? e)}`);
        throw e;
      }

      if (idCierre != null && prep.alCerrar) await prep.alCerrar(manager, idCierre);

      return {
        id_apertura: params.idApertura,
        id_cierre: idCierre,
        cerrada: true,
        monto_conteo: conteoValido ? Dinero.desdeNumeroRedondeado(Number(montoConteo)).aNumero() : null,
      };
    });
  }

  /**
   * Resumen informativo del turno: ventas de la caja desde la apertura (no bloquea; solo
   * informa al cerrar). Total y desglose por método en paralelo.
   */
  async resumenTurno(apertura: AperturaSesion): Promise<ResumenTurno> {
    const m = await this.metaSesion();
    if (!apertura.fecha || !apertura.id_caja || !m.apertura.colFecha) {
      return { ventas: 0, total: 0, por_metodo: [] };
    }
    // La ventana se arma en SQL con la fecha guardada de la apertura (sin ir y volver a JS).
    const sinAnuladas = m.snapshot.tieneColumna('ventas', 'estado')
      ? `AND COALESCE(v.estado, 'activa') <> 'anulada'`
      : '';
    const ventana = `v.id_caja = a.id_caja
            AND v.fecha >= a.${m.apertura.colFecha}
            ${sinAnuladas}`;

    const [totales, filas] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS ventas, COALESCE(SUM(v.total), 0)::text AS total
           FROM aperturas_caja a
           JOIN ventas v ON ${ventana}
          WHERE a.id_apertura = $1`,
        [apertura.id_apertura],
      ),
      this.dataSource.query(
        `SELECT COALESCE(mp.nombre, 'Otro') AS metodo,
                COALESCE(SUM(vp.monto), 0)::text AS total,
                COUNT(*)::int AS cantidad
           FROM aperturas_caja a
           JOIN ventas v ON ${ventana}
           JOIN venta_pago vp ON vp.id_venta = v.id_venta
           LEFT JOIN metodos_pago mp ON mp.id_metodo = vp.id_metodo
          WHERE a.id_apertura = $1
          GROUP BY 1
          ORDER BY SUM(vp.monto) DESC`,
        [apertura.id_apertura],
      ).catch((e: Error) => {
        this.log.warn(`Resumen por método no disponible: ${e?.message ?? e}`);
        return [];
      }),
    ]);

    return {
      ventas: Number(totales[0]?.ventas ?? 0),
      total: Dinero.desdeBd(totales[0]?.total).aNumero(),
      por_metodo: (filas || []).map((f: any) => ({
        metodo: String(f.metodo || 'Otro'),
        total: Dinero.desdeBd(f.total).aNumero(),
        cantidad: Number(f.cantidad || 0),
      })),
    };
  }

  private mapApertura(f: any): AperturaSesion {
    return {
      id_apertura: Number(f.id_apertura),
      id_caja: Number(f.id_caja),
      caja_nombre: String(f.caja_nombre ?? `Caja ${f.id_caja}`),
      id_sucursal: f.id_sucursal != null ? Number(f.id_sucursal) : null,
      sucursal_nombre: f.sucursal_nombre != null ? String(f.sucursal_nombre) : null,
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      fecha: f.fecha != null ? new Date(f.fecha).toISOString() : null,
      monto_inicial:
        f.monto_inicial != null && f.monto_inicial !== ''
          ? Number(f.monto_inicial)
          : null,
    };
  }
}
