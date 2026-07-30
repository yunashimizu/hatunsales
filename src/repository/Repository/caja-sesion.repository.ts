import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

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

type MetaApertura = {
  colFecha: string | null;
  colMonto: string | null;
  listo: boolean;
};

type MetaCierre = {
  colFecha: string | null;
  colMonto: string | null;
  colObs: string | null;
  tieneIdUsuario: boolean;
  listo: boolean;
};

/**
 * Sesión de caja (apertura / cierre).
 * Descubre columnas reales para no romper esquemas distintos.
 */
@Injectable()
export class CajaSesionRepository {
  private readonly log = new Logger(CajaSesionRepository.name);
  private metaApertura: MetaApertura | null = null;
  private metaCierre: MetaCierre | null = null;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async asegurarSchema(): Promise<void> {
    await this.dataSource.query(`
      ALTER TABLE aperturas_caja ADD COLUMN IF NOT EXISTS id_usuario INTEGER
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_aperturas_caja_id_usuario
        ON aperturas_caja (id_usuario)
        WHERE id_usuario IS NOT NULL
    `).catch(() => undefined);

    // Columnas opcionales: ignorar si el tipo/nombre choca
    for (const sql of [
      `ALTER TABLE aperturas_caja ADD COLUMN IF NOT EXISTS monto_inicial NUMERIC(12, 2)`,
      `ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS id_usuario INTEGER`,
      `ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS monto_conteo NUMERIC(12, 2)`,
      `ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS observacion TEXT`,
    ]) {
      await this.dataSource.query(sql).catch(() => undefined);
    }

    await this.dataSource.query(
      `INSERT INTO configuraciones (clave, valor)
       SELECT v.clave, v.valor
         FROM (VALUES
           ('caja_modo', 'blando'),
           ('caja_estricto_bypass_admin', 'false')
         ) AS v(clave, valor)
        WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave)`,
    ).catch(() => undefined);

    this.metaApertura = null;
    this.metaCierre = null;
  }

  private async columnas(tabla: string): Promise<Set<string>> {
    const filas = await this.dataSource.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [tabla],
    );
    return new Set((filas as { column_name: string }[]).map((f) => f.column_name));
  }

  private async metaAp(): Promise<MetaApertura> {
    if (this.metaApertura?.listo) return this.metaApertura;
    const cols = await this.columnas('aperturas_caja');
    const colFecha = ['fecha', 'fecha_apertura', 'abierto_en', 'created_at'].find((c) => cols.has(c)) ?? null;
    const colMonto = ['monto_inicial', 'saldo_inicial', 'monto_apertura', 'monto'].find((c) => cols.has(c)) ?? null;
    this.metaApertura = { colFecha, colMonto, listo: true };
    return this.metaApertura;
  }

  private async metaCi(): Promise<MetaCierre> {
    if (this.metaCierre?.listo) return this.metaCierre;
    const cols = await this.columnas('cierres_caja');
    const colFecha = ['fecha', 'fecha_cierre', 'cerrado_en', 'created_at'].find((c) => cols.has(c)) ?? null;
    const colMonto = ['monto_conteo', 'monto_cierre', 'saldo_final', 'monto'].find((c) => cols.has(c)) ?? null;
    const colObs = ['observacion', 'observaciones', 'nota', 'comentario'].find((c) => cols.has(c)) ?? null;
    this.metaCierre = {
      colFecha,
      colMonto,
      colObs,
      tieneIdUsuario: cols.has('id_usuario'),
      listo: true,
    };
    return this.metaCierre;
  }

  async modoCaja(): Promise<'blando' | 'estricto'> {
    const filas = await this.dataSource.query(
      `SELECT valor FROM configuraciones WHERE clave = 'caja_modo' LIMIT 1`,
    );
    const v = String(filas[0]?.valor ?? 'blando').toLowerCase();
    return v === 'estricto' ? 'estricto' : 'blando';
  }

  async bypassAdminEstricto(): Promise<boolean> {
    const filas = await this.dataSource.query(
      `SELECT valor FROM configuraciones WHERE clave = 'caja_estricto_bypass_admin' LIMIT 1`,
    );
    const v = String(filas[0]?.valor ?? 'false').toLowerCase();
    return ['true', '1', 'si', 'sí'].includes(v);
  }

  async sesionUsuario(idUsuario: number): Promise<AperturaSesion | null> {
    await this.asegurarSchema();
    const meta = await this.metaAp();
    const orden = meta.colFecha ? `a.${meta.colFecha} DESC` : 'a.id_apertura DESC';
    const selFecha = meta.colFecha ? `a.${meta.colFecha}` : 'NULL';
    const selMonto = meta.colMonto ? `a.${meta.colMonto}` : 'NULL';

    const nombreExpr = await this.exprNombreCaja('c');
    const colsCaja = await this.columnas('cajas');
    const joinSuc = colsCaja.has('id_sucursal')
      ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal'
      : '';
    const selSuc = colsCaja.has('id_sucursal')
      ? 'c.id_sucursal, s.nombre AS sucursal_nombre'
      : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre';

    const filas = await this.dataSource.query(
      `SELECT a.id_apertura,
              a.id_caja,
              ${nombreExpr} AS caja_nombre,
              ${selSuc},
              a.id_usuario,
              ${selFecha} AS fecha,
              ${selMonto} AS monto_inicial
         FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
         ${joinSuc}
        WHERE a.id_usuario = $1
          AND NOT EXISTS (
                SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              )
        ORDER BY ${orden}
        LIMIT 1`,
      [idUsuario],
    );

    if (!filas[0]) return null;
    return this.mapApertura(filas[0]);
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

  private async exprNombreCaja(alias = 'c'): Promise<string> {
    const cols = await this.columnas('cajas');
    if (cols.has('nombre')) return `COALESCE(${alias}.nombre, 'Caja ' || ${alias}.id_caja::text)`;
    if (cols.has('descripcion')) {
      return `COALESCE(${alias}.descripcion, 'Caja ' || ${alias}.id_caja::text)`;
    }
    return `'Caja ' || ${alias}.id_caja::text`;
  }

  async listarDisponibles(): Promise<CajaDisponible[]> {
    await this.asegurarSchema();
    const nombreExpr = await this.exprNombreCaja('c');
    const cols = await this.columnas('cajas');
    const tieneSucursal = cols.has('id_sucursal');

    const filas = tieneSucursal
      ? await this.dataSource.query(
          `SELECT c.id_caja,
                  ${nombreExpr} AS nombre,
                  c.id_sucursal,
                  s.nombre AS sucursal_nombre,
                  EXISTS (
                    SELECT 1 FROM aperturas_caja a
                     WHERE a.id_caja = c.id_caja
                       AND NOT EXISTS (
                             SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
                           )
                  ) AS ocupada
             FROM cajas c
             LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal
            ORDER BY c.id_caja ASC`,
        )
      : await this.dataSource.query(
          `SELECT c.id_caja,
                  ${nombreExpr} AS nombre,
                  NULL::int AS id_sucursal,
                  NULL::text AS sucursal_nombre,
                  EXISTS (
                    SELECT 1 FROM aperturas_caja a
                     WHERE a.id_caja = c.id_caja
                       AND NOT EXISTS (
                             SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
                           )
                  ) AS ocupada
             FROM cajas c
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

  async abrir(params: {
    idCaja: number;
    idUsuario: number;
    montoInicial?: number | null;
  }): Promise<AperturaSesion> {
    await this.asegurarSchema();
    const meta = await this.metaAp();

    return this.dataSource.transaction(async (manager) => {
      // Evita doble click / carrera
      await manager.query(`SELECT id_caja FROM cajas WHERE id_caja = $1 FOR UPDATE`, [params.idCaja]);

      if (await this.tieneAperturaAbiertaUsuario(params.idUsuario, manager)) {
        throw new Error('CAJA_YA_ABIERTA_USUARIO');
      }
      if (await this.cajaOcupada(params.idCaja, manager)) {
        throw new Error('CAJA_OCUPADA');
      }

      const cols = ['id_caja', 'id_usuario'];
      const vals: any[] = [params.idCaja, params.idUsuario];
      if (meta.colFecha) {
        cols.push(meta.colFecha);
        vals.push(new Date());
      }
      if (meta.colMonto && params.montoInicial != null && Number.isFinite(Number(params.montoInicial))) {
        cols.push(meta.colMonto);
        vals.push(Number(params.montoInicial));
      }

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const insertadas = await manager.query(
        `INSERT INTO aperturas_caja (${cols.join(', ')})
         VALUES (${placeholders})
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
    const meta = await this.metaAp();
    const selFecha = meta.colFecha ? `a.${meta.colFecha}` : 'NULL';
    const selMonto = meta.colMonto ? `a.${meta.colMonto}` : 'NULL';

    const nombreExpr = await this.exprNombreCaja('c');
    const colsCaja = await this.columnas('cajas');
    const joinSuc = colsCaja.has('id_sucursal')
      ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal'
      : '';
    const selSuc = colsCaja.has('id_sucursal')
      ? 'c.id_sucursal, s.nombre AS sucursal_nombre'
      : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre';

    const filas = await q.query(
      `SELECT a.id_apertura,
              a.id_caja,
              ${nombreExpr} AS caja_nombre,
              ${selSuc},
              a.id_usuario,
              ${selFecha} AS fecha,
              ${selMonto} AS monto_inicial
         FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
         ${joinSuc}
        WHERE a.id_apertura = $1
        LIMIT 1`,
      [idApertura],
    );
    if (!filas[0]) return null;
    return this.mapApertura(filas[0]);
  }

  async estaCerrada(idApertura: number, manager?: EntityManager): Promise<boolean> {
    const q = manager ?? this.dataSource;
    const filas = await q.query(
      `SELECT 1 FROM cierres_caja WHERE id_apertura = $1 LIMIT 1`,
      [idApertura],
    );
    return filas.length > 0;
  }

  async cerrar(params: {
    idApertura: number;
    idUsuario: number;
    montoConteo?: number | null;
    observacion?: string | null;
  }): Promise<{ id_apertura: number; id_cierre: number | null; cerrada: boolean; monto_conteo: number | null }> {
    await this.asegurarSchema();
    const meta = await this.metaCi();

    return this.dataSource.transaction(async (manager) => {
      const apertura = await this.obtenerAperturaPorId(params.idApertura, manager);
      if (!apertura) throw new Error('CAJA_APERTURA_NO_ENCONTRADA');
      if (await this.estaCerrada(params.idApertura, manager)) {
        throw new Error('CAJA_YA_CERRADA');
      }

      const cols = ['id_apertura'];
      const vals: any[] = [params.idApertura];
      if (meta.tieneIdUsuario) {
        cols.push('id_usuario');
        vals.push(params.idUsuario);
      }
      if (meta.colFecha) {
        cols.push(meta.colFecha);
        vals.push(new Date());
      }
      if (meta.colMonto && params.montoConteo != null && Number.isFinite(Number(params.montoConteo))) {
        cols.push(meta.colMonto);
        vals.push(Number(params.montoConteo));
      }
      if (meta.colObs && params.observacion != null && String(params.observacion).trim()) {
        cols.push(meta.colObs);
        vals.push(String(params.observacion).trim());
      }

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      let idCierre: number | null = null;
      try {
        const insertadas = await manager.query(
          `INSERT INTO cierres_caja (${cols.join(', ')})
           VALUES (${placeholders})
           RETURNING *`,
          vals,
        );
        const row = insertadas[0] ?? {};
        idCierre =
          row.id_cierre != null
            ? Number(row.id_cierre)
            : row.id != null
              ? Number(row.id)
              : null;
      } catch (e) {
        this.log.error(`Error al insertar cierre: ${String((e as Error)?.message ?? e)}`);
        throw e;
      }

      return {
        id_apertura: params.idApertura,
        id_cierre: idCierre,
        cerrada: true,
        monto_conteo:
          params.montoConteo != null && Number.isFinite(Number(params.montoConteo))
            ? Number(params.montoConteo)
            : null,
      };
    });
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
