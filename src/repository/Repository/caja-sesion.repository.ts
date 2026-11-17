import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ConfiguracionRepository } from './configuracion.repository';
import { EsquemaCajaService, SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { Dinero } from '../../caja/dominio/dinero';
import { sqlFinExclusivoDiaLima, sqlInicioDiaLima } from '../../util/fecha-lima';

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
  /** false = caja desactivada (no se puede abrir). Sin columna `estado`, toda caja es activa. */
  activa: boolean;
  /** Efectivo contado (monto_conteo) en el último cierre de esta caja; null si no hay o no existe la columna. */
  sugerido_inicial: number | null;
};

/** Un local (fila de `sucursales`) tal como lo ve el tablero de Caja. */
export type LocalCaja = {
  id_sucursal: number;
  nombre: string;
  direccion: string | null;
};

/** Quién tiene abierta una caja (GET /caja/disponibles, dato informativo). */
export type OcupanteCaja = {
  id_usuario: number | null;
  usuario_nombre: string | null;
  abierta_en: string | null;
};

/** Filtros de turnos (aperturas). Las fechas son AAAA-MM-DD en días de Lima, ya validadas. */
export type FiltroTurnos = {
  idSucursal?: number;
  idCaja?: number;
  idUsuario?: number;
  desde?: string;
  hasta?: string;
};

/** Un turno (apertura + su cierre si lo tiene) listo para el arqueo por sucursal. */
export type FilaTurno = {
  id_apertura: number;
  id_caja: number;
  caja_nombre: string;
  id_sucursal: number | null;
  sucursal_nombre: string | null;
  id_usuario: number | null;
  usuario_nombre: string | null;
  abierta_en: string | null;
  cerrada_en: string | null;
  /** null = turno antiguo sin dato (no es lo mismo que 0.00). */
  monto_inicial: Dinero | null;
  /** Efectivo contado al cerrar; null si el turno sigue abierto o el cierre no lo guardó. */
  monto_conteo: Dinero | null;
  cerrada: boolean;
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
type MetaCaja = { exprNombre: string; tieneNombre: boolean; tieneSucursal: boolean; tieneEstado: boolean };

interface MetaSesion {
  snapshot: SnapshotEsquema;
  apertura: MetaApertura;
  cierre: MetaCierre;
  caja: MetaCaja;
}

const CANDADO_APERTURA_USUARIO = 'caja:apertura:usuario:';

/** Nombres de caja se comparan sin distinguir mayúsculas ni espacios de los extremos. */
const normalizarNombre = (n: string) => n.trim().toLowerCase();
/** Instante UTC de una columna `timestamp` sin zona que guarda hora UTC. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

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
        tieneNombre: colsCaja.has('nombre'),
        tieneSucursal: colsCaja.has('id_sucursal'),
        tieneEstado: colsCaja.has('estado'),
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

  /**
   * Subconsulta (correlacionada con `c.id_caja`) del efectivo contado en el último cierre de esa
   * caja. Sin columna de conteo en cierres_caja devuelve NULL: el sugerido simplemente no existe.
   */
  private sqlSugerido(m: MetaSesion, refCaja: string): string {
    if (!m.cierre.colMonto) return 'NULL::text';
    return `(SELECT ci.${m.cierre.colMonto}::text
               FROM aperturas_caja a2
               JOIN cierres_caja ci ON ci.id_apertura = a2.id_apertura
              WHERE a2.id_caja = ${refCaja}
              ORDER BY a2.id_apertura DESC
              LIMIT 1)`;
  }

  /** Efectivo contado al cerrar el último turno de la caja (null si no hay dato). */
  async sugeridoInicial(idCaja: number): Promise<number | null> {
    const m = await this.metaSesion();
    if (!m.cierre.colMonto) return null;
    const filas = await this.dataSource.query(`SELECT ${this.sqlSugerido(m, '$1::int')} AS sugerido`, [idCaja]);
    const v = filas[0]?.sugerido;
    return v != null && v !== '' ? Dinero.desdeBd(v).aNumero() : null;
  }

  /** Cajas con su local, si están ocupadas y su sugerido; `idCaja` limita a una sola. */
  private async consultarCajas(q: Pick<DataSource, 'query'>, idCaja?: number): Promise<CajaDisponible[]> {
    const m = await this.metaSesion();
    const filas = await q.query(
      `SELECT c.id_caja,
              ${m.caja.exprNombre} AS nombre,
              ${m.caja.tieneSucursal ? 'c.id_sucursal, s.nombre AS sucursal_nombre' : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre'},
              ${m.caja.tieneEstado ? 'COALESCE(c.estado, TRUE)' : 'TRUE'} AS activa,
              EXISTS (
                SELECT 1 FROM aperturas_caja a
                 WHERE a.id_caja = c.id_caja
                   AND NOT EXISTS (
                         SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
                       )
              ) AS ocupada,
              ${this.sqlSugerido(m, 'c.id_caja')} AS sugerido_inicial
         FROM cajas c
         ${m.caja.tieneSucursal ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal' : ''}
        ${idCaja != null ? 'WHERE c.id_caja = $1' : ''}
        ORDER BY c.id_caja ASC`,
      idCaja != null ? [idCaja] : [],
    );

    return (filas as any[]).map((f) => ({
      id_caja: Number(f.id_caja),
      nombre: String(f.nombre ?? `Caja ${f.id_caja}`),
      id_sucursal: f.id_sucursal != null ? Number(f.id_sucursal) : null,
      sucursal_nombre: f.sucursal_nombre != null ? String(f.sucursal_nombre) : null,
      ocupada: f.ocupada === true || f.ocupada === 't' || f.ocupada === 1,
      activa: !(f.activa === false || f.activa === 'f' || f.activa === 0),
      sugerido_inicial: f.sugerido_inicial != null && f.sugerido_inicial !== '' ? Dinero.desdeBd(f.sugerido_inicial).aNumero() : null,
    }));
  }

  async listarDisponibles(): Promise<CajaDisponible[]> {
    return this.consultarCajas(this.dataSource);
  }

  /** Una caja con la forma de `listarDisponibles` (null si no existe). */
  async cajaDisponible(idCaja: number, manager?: EntityManager): Promise<CajaDisponible | null> {
    return (await this.consultarCajas(manager ?? this.dataSource, idCaja))[0] ?? null;
  }

  /** Todos los locales (`sucursales`), por nombre. Consulta aparte: quien la llama decide qué hacer si falla. */
  async listarLocales(): Promise<LocalCaja[]> {
    const filas = await this.dataSource.query(
      `SELECT id_sucursal, nombre, direccion
         FROM sucursales
        ORDER BY lower(nombre) ASC, id_sucursal ASC`,
    );
    return (filas as any[]).map((f) => ({
      id_sucursal: Number(f.id_sucursal),
      nombre: String(f.nombre ?? `Local ${f.id_sucursal}`),
      direccion: f.direccion != null && String(f.direccion).trim() !== '' ? String(f.direccion) : null,
    }));
  }

  /** Nombres de las cajas de un local (null = cajas sin local). Para elegir «Caja N» y detectar repetidos. */
  private async nombresDeCajas(
    manager: EntityManager,
    idSucursal: number | null,
    excluirIdCaja?: number,
  ): Promise<string[]> {
    const filas = await manager.query(
      `SELECT nombre
         FROM cajas
        WHERE id_sucursal IS NOT DISTINCT FROM $1::int
          AND ($2::int IS NULL OR id_caja <> $2::int)`,
      [idSucursal, excluirIdCaja ?? null],
    );
    return (filas as any[]).map((f) => String(f.nombre ?? ''));
  }

  /**
   * Crea una caja en un local. Bloquea la fila del local antes de leer los nombres e insertar,
   * así dos altas a la vez no repiten nombre ni número. Errores: SUCURSAL_NO_ENCONTRADA,
   * CAJA_NOMBRE_REPETIDO, CAJA_ESQUEMA_NO_SOPORTA.
   */
  async crearCaja(params: { idSucursal: number; nombre?: string | null }): Promise<CajaDisponible> {
    const m = await this.metaSesion();
    if (!m.caja.tieneNombre || !m.caja.tieneSucursal) throw new Error('CAJA_ESQUEMA_NO_SOPORTA');

    return this.dataSource.transaction(async (manager) => {
      const local = await manager.query(
        `SELECT id_sucursal FROM sucursales WHERE id_sucursal = $1 FOR UPDATE`,
        [params.idSucursal],
      );
      if (!local[0]) throw new Error('SUCURSAL_NO_ENCONTRADA');

      const usados = new Set((await this.nombresDeCajas(manager, params.idSucursal)).map((n) => normalizarNombre(n)));
      let nombre = (params.nombre ?? '').trim();
      if (nombre === '') {
        let n = 1;
        while (usados.has(normalizarNombre(`Caja ${n}`))) n += 1;
        nombre = `Caja ${n}`;
      } else if (usados.has(normalizarNombre(nombre))) {
        throw new Error('CAJA_NOMBRE_REPETIDO');
      }

      const filas = await manager.query(
        `INSERT INTO cajas (id_sucursal, nombre) VALUES ($1, $2) RETURNING id_caja`,
        [params.idSucursal, nombre],
      );
      const creada = await this.cajaDisponible(Number(filas[0]?.id_caja), manager);
      if (!creada) throw new Error('CAJA_NO_ENCONTRADA');
      return creada;
    });
  }

  /**
   * Renombra y/o (des)activa una caja. Orden de candados fijo: fila del local → fila de la caja
   * (el mismo `FOR UPDATE` que `abrir`). Errores: CAJA_NO_ENCONTRADA, CAJA_NOMBRE_REPETIDO,
   * CAJA_CON_TURNO_ABIERTO, CAJA_ESQUEMA_NO_SOPORTA.
   */
  async actualizarCaja(idCaja: number, cambios: { nombre?: string; activa?: boolean }): Promise<CajaDisponible> {
    const m = await this.metaSesion();
    const renombra = cambios.nombre !== undefined;
    const cambiaEstado = cambios.activa !== undefined;
    if (renombra && !m.caja.tieneNombre) throw new Error('CAJA_ESQUEMA_NO_SOPORTA');
    if (cambiaEstado && !m.caja.tieneEstado) throw new Error('CAJA_ESQUEMA_NO_SOPORTA');

    return this.dataSource.transaction(async (manager) => {
      const previa = await this.cajaDisponible(idCaja, manager);
      if (!previa) throw new Error('CAJA_NO_ENCONTRADA');

      if (renombra && previa.id_sucursal != null) {
        await manager.query(`SELECT id_sucursal FROM sucursales WHERE id_sucursal = $1 FOR UPDATE`, [previa.id_sucursal]);
      }
      const bloqueada = await manager.query(`SELECT id_caja FROM cajas WHERE id_caja = $1 FOR UPDATE`, [idCaja]);
      if (!bloqueada[0]) throw new Error('CAJA_NO_ENCONTRADA');

      if (renombra) {
        const nombre = (cambios.nombre ?? '').trim();
        const usados = await this.nombresDeCajas(manager, previa.id_sucursal, idCaja);
        if (usados.some((n) => normalizarNombre(n) === normalizarNombre(nombre))) {
          throw new Error('CAJA_NOMBRE_REPETIDO');
        }
        await manager.query(`UPDATE cajas SET nombre = $1 WHERE id_caja = $2`, [nombre, idCaja]);
      }

      if (cambiaEstado) {
        if (cambios.activa === false && (await this.cajaOcupada(idCaja, manager))) {
          throw new Error('CAJA_CON_TURNO_ABIERTO');
        }
        await manager.query(`UPDATE cajas SET estado = $1 WHERE id_caja = $2`, [cambios.activa === true, idCaja]);
      }

      const actual = await this.cajaDisponible(idCaja, manager);
      if (!actual) throw new Error('CAJA_NO_ENCONTRADA');
      return actual;
    });
  }

  /**
   * Quién tiene cada caja ahora: turnos sin cierre, uno por caja (el más reciente si hubiera más).
   * Dato informativo para el tablero de Caja; usa las mismas expresiones de nombre y fecha que
   * `listarTurnos`, así que no supone ninguna columna nueva.
   */
  async ocupantesDeCajas(): Promise<Map<number, OcupanteCaja>> {
    const m = await this.metaSesion();
    const selFecha = m.apertura.colFecha ? `a.${m.apertura.colFecha}` : 'NULL::timestamp';
    const orden = m.apertura.colFecha ? `a.id_caja, ${selFecha} DESC, a.id_apertura DESC` : 'a.id_caja, a.id_apertura DESC';
    const filas = await this.dataSource.query(
      `SELECT DISTINCT ON (a.id_caja)
              a.id_caja,
              a.id_usuario,
              NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre,
              to_char(${selFecha}, ${ISO_UTC}) AS abierta_en
         FROM aperturas_caja a
         LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
        WHERE NOT EXISTS (
                SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
              )
        ORDER BY ${orden}`,
    );
    const mapa = new Map<number, OcupanteCaja>();
    for (const f of filas as any[]) {
      mapa.set(Number(f.id_caja), {
        id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
        usuario_nombre: f.usuario_nombre != null ? String(f.usuario_nombre) : null,
        abierta_en: f.abierta_en ?? null,
      });
    }
    return mapa;
  }

  // ── Turnos para el arqueo por sucursal ───────────────────────

  /** Sucursales de las cajas donde el usuario tuvo turnos (null = caja sin sucursal). Es "su sede". */
  async sucursalesDeUsuario(idUsuario: number): Promise<(number | null)[]> {
    const m = await this.metaSesion();
    const filas = await this.dataSource.query(
      `SELECT DISTINCT ${m.caja.tieneSucursal ? 'c.id_sucursal' : 'NULL::int AS id_sucursal'}
         FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
        WHERE a.id_usuario = $1`,
      [idUsuario],
    );
    return (filas as any[]).map((f) => (f.id_sucursal != null ? Number(f.id_sucursal) : null));
  }

  /** Sucursal de una caja: undefined si la caja no existe, null si no tiene sucursal. */
  async sucursalDeCaja(idCaja: number): Promise<number | null | undefined> {
    const m = await this.metaSesion();
    const filas = await this.dataSource.query(
      `SELECT ${m.caja.tieneSucursal ? 'c.id_sucursal' : 'NULL::int AS id_sucursal'} FROM cajas c WHERE c.id_caja = $1 LIMIT 1`,
      [idCaja],
    );
    if (!filas[0]) return undefined;
    return filas[0].id_sucursal != null ? Number(filas[0].id_sucursal) : null;
  }

  /** FROM/WHERE común de los listados de turnos. Todo valor del usuario va como parámetro. */
  private armarTurnos(m: MetaSesion, filtro: FiltroTurnos): { from: string; where: string; params: unknown[] } {
    const params: unknown[] = [];
    const ph = (valor: unknown) => {
      params.push(valor);
      return `$${params.length}`;
    };
    const condiciones: string[] = [];
    if (filtro.idSucursal != null) {
      condiciones.push(m.caja.tieneSucursal ? `c.id_sucursal = ${ph(filtro.idSucursal)}` : 'FALSE');
    }
    if (filtro.idCaja != null) condiciones.push(`a.id_caja = ${ph(filtro.idCaja)}`);
    if (filtro.idUsuario != null) condiciones.push(`a.id_usuario = ${ph(filtro.idUsuario)}`);
    if (m.apertura.colFecha) {
      if (filtro.desde) condiciones.push(`a.${m.apertura.colFecha} >= ${sqlInicioDiaLima(ph(filtro.desde))}`);
      if (filtro.hasta) condiciones.push(`a.${m.apertura.colFecha} < ${sqlFinExclusivoDiaLima(ph(filtro.hasta))}`);
    }

    const cierreFecha = m.cierre.colFecha ?? 'NULL::timestamp';
    const cierreMonto = m.cierre.colMonto ? `${m.cierre.colMonto}::text` : 'NULL::text';
    const ordenCierre = m.cierre.colFecha ? `${m.cierre.colFecha} ASC NULLS LAST` : 'id_apertura';
    const from = `FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
         ${m.caja.tieneSucursal ? 'LEFT JOIN sucursales s ON s.id_sucursal = c.id_sucursal' : ''}
         LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
         LEFT JOIN LATERAL (
                SELECT ${cierreFecha} AS fecha, ${cierreMonto} AS monto
                  FROM cierres_caja
                 WHERE id_apertura = a.id_apertura
                 ORDER BY ${ordenCierre}
                 LIMIT 1
              ) ci ON TRUE`;
    return { from, where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '', params };
  }

  /**
   * Turnos (más recientes primero). Con `pagina` devuelve una página y el total; sin ella,
   * todos los del filtro (para sumar por sucursal).
   */
  async listarTurnos(
    filtro: FiltroTurnos,
    pagina?: { limite: number; offset: number },
  ): Promise<{ filas: FilaTurno[]; total: number }> {
    const m = await this.metaSesion();
    const { from, where, params } = this.armarTurnos(m, filtro);
    const selFecha = m.apertura.colFecha ? `a.${m.apertura.colFecha}` : 'NULL::timestamp';
    const selMonto = m.apertura.colMonto ? `a.${m.apertura.colMonto}::text` : 'NULL::text';
    const selSuc = m.caja.tieneSucursal
      ? 'c.id_sucursal, s.nombre AS sucursal_nombre'
      : 'NULL::int AS id_sucursal, NULL::text AS sucursal_nombre';
    const orden = m.apertura.colFecha ? `${selFecha} DESC, a.id_apertura DESC` : 'a.id_apertura DESC';

    const paramsPagina = [...params];
    let limite = '';
    if (pagina) {
      paramsPagina.push(pagina.limite, pagina.offset);
      limite = `LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}`;
    }

    const [filas, conteo] = await Promise.all([
      this.dataSource.query(
        `SELECT a.id_apertura,
                a.id_caja,
                ${m.caja.exprNombre} AS caja_nombre,
                ${selSuc},
                a.id_usuario,
                NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario_nombre,
                to_char(${selFecha}, ${ISO_UTC}) AS abierta_en,
                to_char(ci.fecha, ${ISO_UTC}) AS cerrada_en,
                ${selMonto} AS monto_inicial,
                ci.monto AS monto_conteo,
                EXISTS (SELECT 1 FROM cierres_caja x WHERE x.id_apertura = a.id_apertura) AS cerrada
           ${from}
           ${where}
          ORDER BY ${orden}
          ${limite}`,
        paramsPagina,
      ),
      pagina
        ? this.dataSource.query(
            `SELECT COUNT(*)::int AS total
               FROM aperturas_caja a
               JOIN cajas c ON c.id_caja = a.id_caja
               ${where}`,
            params,
          )
        : Promise.resolve(null),
    ]);

    const mapeadas: FilaTurno[] = (filas as any[]).map((f) => ({
      id_apertura: Number(f.id_apertura),
      id_caja: Number(f.id_caja),
      caja_nombre: String(f.caja_nombre ?? `Caja ${f.id_caja}`),
      id_sucursal: f.id_sucursal != null ? Number(f.id_sucursal) : null,
      sucursal_nombre: f.sucursal_nombre != null ? String(f.sucursal_nombre) : null,
      id_usuario: f.id_usuario != null ? Number(f.id_usuario) : null,
      usuario_nombre: f.usuario_nombre != null ? String(f.usuario_nombre) : null,
      abierta_en: f.abierta_en ?? null,
      cerrada_en: f.cerrada_en ?? null,
      monto_inicial: f.monto_inicial != null && f.monto_inicial !== '' ? Dinero.desdeBd(f.monto_inicial) : null,
      monto_conteo: f.monto_conteo != null && f.monto_conteo !== '' ? Dinero.desdeBd(f.monto_conteo) : null,
      cerrada: f.cerrada === true || f.cerrada === 't' || f.cerrada === 1,
    }));
    return { filas: mapeadas, total: conteo ? Number(conteo[0]?.total ?? 0) : mapeadas.length };
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
      const bloqueada = await manager.query(
        `SELECT id_caja${m.caja.tieneEstado ? ', COALESCE(estado, TRUE) AS activa' : ''} FROM cajas WHERE id_caja = $1 FOR UPDATE`,
        [params.idCaja],
      );
      if (bloqueada?.[0] && (bloqueada[0].activa === false || bloqueada[0].activa === 'f')) {
        throw new Error('CAJA_DESACTIVADA');
      }

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
      // La fecha la pone la BD con clock_timestamp() (hora real, tras los candados), igual que
      // ventas.fecha y el cierre: así apertura ≤ venta < cierre y dos turnos seguidos no se solapan.
      if (m.apertura.colFecha) {
        cols.push(m.apertura.colFecha);
        placeholders.push('clock_timestamp()');
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
      // clock_timestamp() y no NOW(): la hora de cerrar, no la de empezar la transacción (que pudo
      // esperar el candado detrás de una venta). Así la venta que esperaba queda dentro del turno.
      if (m.cierre.colFecha) {
        cols.push(m.cierre.colFecha);
        placeholders.push('clock_timestamp()');
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
   *
   * Solo ventas de mostrador: una venta web (origen 'tienda') puede quedar asignada a la
   * caja abierta, pero se cobra fuera de la gaveta. El arqueo (sqlEsperadoTurno) ya la deja
   * aparte; si el resumen la sumaba, el total del turno no cuadraba con el arqueo.
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
    const soloMostrador = m.snapshot.tieneColumna('ventas', 'origen')
      ? `AND COALESCE(v.origen, 'mostrador') = 'mostrador'`
      : '';
    const ventana = `v.id_caja = a.id_caja
            AND v.fecha >= a.${m.apertura.colFecha}
            ${sinAnuladas}
            ${soloMostrador}`;

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
