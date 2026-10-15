import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import { Dinero } from '../../caja/dominio/dinero';
import { filasDe } from '../../caja/bd/resultado-consulta';
import { SQL_HOY_LIMA } from '../../util/fecha-lima';

export interface LineaCredito {
  credito_activo: boolean;
  limite_credito: number;
  dias_credito: number;
  saldo_pendiente: number;
  disponible: number;
  denominacion: string;
}

export interface MetodoPagoActivo {
  id_metodo: number;
  nombre: string;
  tipo: string;
}

/** Estados que se pueden pedir en el filtro del listado. */
export const ESTADOS_CXC = ['pendiente', 'parcial', 'pagado', 'vencido', 'anulado'] as const;

/** Los métodos de pago casi no cambian y se leen en cada venta. */
const VIGENCIA_METODOS_MS = 30_000;
/** Clave del candado consultivo de la tarea de vencimientos (una sola réplica la ejecuta). */
const CANDADO_VENCIMIENTOS = 7_310_031;

/**
 * Estado "visible" de la cuenta: vencida si pasó la fecha en hora de Lima, aunque la tarea
 * programada aún no la haya marcado. Así los GET no escriben en la BD.
 */
const SQL_ESTADO_CXC = `CASE
    WHEN cxc.estado IN ('pendiente', 'parcial') AND cxc.saldo > 0 AND cxc.fecha_vencimiento < ${SQL_HOY_LIMA}
      THEN 'vencido'
    ELSE cxc.estado
  END`;

const COLUMNAS_CXC = `cxc.id_cxc, cxc.id_venta, cxc.id_cliente, cxc.id_empresa, cxc.monto_total, cxc.saldo,
       cxc.fecha_emision, to_char(cxc.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
       ${SQL_ESTADO_CXC} AS estado, cxc.creado_en`;

/**
 * Crédito y cuentas por cobrar. Sin DDL: si faltan las tablas (sql/fase11), las operaciones
 * de crédito responden 503 con el aviso del script.
 */
@Injectable()
export class CreditoRepository {
  private readonly log = new Logger(CreditoRepository.name);
  private metodosCache: { valor: MetodoPagoActivo[]; expira: number } | null = null;
  private metodosEnCurso: Promise<MetodoPagoActivo[]> | null = null;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  /** 503 "Falta ejecutar sql/fase11_caja_arqueo_ventas.sql en Railway" si falta el esquema de crédito. */
  async exigirEsquema(): Promise<void> {
    await this.esquema.exigir('credito');
  }

  async idMetodoCredito(): Promise<number | null> {
    const metodos = await this.metodosConTipo();
    const credito = metodos.find((m) => {
      const tipo = String(m.tipo ?? '').trim().toLowerCase();
      const nombre = String(m.nombre ?? '').trim().toLowerCase();
      return tipo === 'credito' || nombre === 'crédito' || nombre === 'credito';
    });
    return credito ? Number(credito.id_metodo) : null;
  }

  /** Métodos activos (caché de 30 s compartida por las peticiones concurrentes). */
  async metodosConTipo(): Promise<MetodoPagoActivo[]> {
    const cache = this.metodosCache;
    if (cache && cache.expira > Date.now()) return cache.valor;
    if (!this.metodosEnCurso) {
      this.metodosEnCurso = this.dataSource
        .query(
          `SELECT id_metodo, nombre, COALESCE(tipo, '') AS tipo
             FROM metodos_pago
            WHERE COALESCE(activo, TRUE) = TRUE
            ORDER BY COALESCE(orden, id_metodo), id_metodo`,
        )
        .then((filas: any[]) => {
          const valor = filas.map((f) => ({ id_metodo: Number(f.id_metodo), nombre: String(f.nombre ?? ''), tipo: String(f.tipo ?? '') }));
          this.metodosCache = { valor, expira: Date.now() + VIGENCIA_METODOS_MS };
          return valor;
        })
        .finally(() => {
          this.metodosEnCurso = null;
        });
    }
    return this.metodosEnCurso;
  }

  limpiarCacheMetodos(): void {
    this.metodosCache = null;
  }

  async lineaCliente(idCliente: number): Promise<LineaCredito | null> {
    await this.exigirEsquema();
    const filas = await this.dataSource.query(
      `SELECT c.id_cliente,
              COALESCE(c.credito_activo, FALSE) AS credito_activo,
              COALESCE(c.limite_credito, 0)::text AS limite_credito,
              COALESCE(c.dias_credito, 15)::int AS dias_credito,
              COALESCE(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), c.nombre, '') AS denominacion,
              COALESCE((
                SELECT SUM(cxc.saldo) FROM cuentas_por_cobrar cxc
                 WHERE cxc.id_cliente = c.id_cliente
                   AND cxc.estado IN ('pendiente', 'parcial', 'vencido')
              ), 0)::text AS saldo_pendiente
         FROM clientes c WHERE c.id_cliente = $1`,
      [idCliente],
    );
    if (!filas[0]) return null;
    return this.mapLinea(filas[0]);
  }

  async lineaEmpresa(idEmpresa: number): Promise<LineaCredito | null> {
    await this.exigirEsquema();
    const filas = await this.dataSource.query(
      `SELECT e.id_empresa,
              COALESCE(e.credito_activo, FALSE) AS credito_activo,
              COALESCE(e.limite_credito, 0)::text AS limite_credito,
              COALESCE(e.dias_credito, 15)::int AS dias_credito,
              COALESCE(e.razon_social, e.nombre_comercial, e.ruc) AS denominacion,
              COALESCE((
                SELECT SUM(cxc.saldo) FROM cuentas_por_cobrar cxc
                 WHERE cxc.id_empresa = e.id_empresa
                   AND cxc.estado IN ('pendiente', 'parcial', 'vencido')
              ), 0)::text AS saldo_pendiente
         FROM empresas e WHERE e.id_empresa = $1`,
      [idEmpresa],
    );
    if (!filas[0]) return null;
    return this.mapLinea(filas[0]);
  }

  private mapLinea(row: any): LineaCredito {
    const limite = Dinero.desdeBd(row.limite_credito);
    const saldo = Dinero.desdeBd(row.saldo_pendiente);
    const disponible = limite.restar(saldo);
    return {
      credito_activo: row.credito_activo === true || row.credito_activo === 't',
      limite_credito: limite.aNumero(),
      dias_credito: Number(row.dias_credito ?? 15) || 15,
      saldo_pendiente: saldo.aNumero(),
      disponible: disponible.esNegativo() ? 0 : disponible.aNumero(),
      denominacion: String(row.denominacion ?? ''),
    };
  }

  /** Crea la cuenta por cobrar dentro de la transacción de quien llama; vence en días de Lima. */
  async crearCxC(
    manager: EntityManager,
    datos: {
      id_venta: number;
      id_cliente?: number | null;
      id_empresa?: number | null;
      monto: number;
      dias: number;
    },
  ): Promise<number> {
    const filas = await manager.query(
      `INSERT INTO cuentas_por_cobrar
         (id_venta, id_cliente, id_empresa, monto_total, saldo, fecha_emision, fecha_vencimiento, estado)
       VALUES ($1, $2, $3, $4::numeric, $4::numeric, NOW(), ${SQL_HOY_LIMA} + $5::int, 'pendiente')
       RETURNING id_cxc`,
      [
        datos.id_venta,
        datos.id_cliente ?? null,
        datos.id_empresa ?? null,
        Dinero.desdeNumeroRedondeado(Number(datos.monto)).aTexto(),
        Math.max(1, Math.trunc(Number(datos.dias)) || 1),
      ],
    );
    return Number(filas[0].id_cxc);
  }

  /** Listado paginado. No escribe: el estado vencido se calcula al leer (hora de Lima). */
  async listar(filtros: {
    estado?: string;
    texto?: string;
    pagina?: number;
    limite?: number;
  }) {
    await this.exigirEsquema();

    const pagina = Math.max(1, Number(filtros.pagina) || 1);
    const limite = Math.min(100, Math.max(1, Number(filtros.limite) || 20));
    const offset = (pagina - 1) * limite;
    const params: any[] = [];
    const where: string[] = ['1=1'];

    if (filtros.estado) {
      params.push(filtros.estado);
      where.push(`(${SQL_ESTADO_CXC}) = $${params.length}`);
    }
    if (filtros.texto?.trim()) {
      params.push(`%${filtros.texto.trim().toLowerCase().slice(0, 100)}%`);
      where.push(`(
        LOWER(COALESCE(c.nombre, '')) LIKE $${params.length}
        OR LOWER(COALESCE(e.razon_social, '')) LIKE $${params.length}
        OR CAST(cxc.id_venta AS TEXT) LIKE $${params.length}
      )`);
    }

    const whereSql = where.join(' AND ');
    const paramsDatos = [...params, limite, offset];
    const [totales, data] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total
           FROM cuentas_por_cobrar cxc
           LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
           LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
          WHERE ${whereSql}`,
        params,
      ),
      this.dataSource.query(
        `SELECT ${COLUMNAS_CXC},
                COALESCE(c.nombre, e.razon_social, e.nombre_comercial, '—') AS deudor,
                COALESCE(CAST(c.dni AS TEXT), e.ruc, '') AS documento
           FROM cuentas_por_cobrar cxc
           LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
           LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
          WHERE ${whereSql}
          ORDER BY cxc.fecha_vencimiento ASC, cxc.id_cxc DESC
          LIMIT $${paramsDatos.length - 1} OFFSET $${paramsDatos.length}`,
        paramsDatos,
      ),
    ]);

    return { data, total: Number(totales[0]?.total ?? 0), pagina, limite };
  }

  async obtener(idCxc: number) {
    await this.exigirEsquema();
    const [filas, abonos] = await Promise.all([
      this.dataSource.query(
        `SELECT ${COLUMNAS_CXC},
                COALESCE(c.nombre, e.razon_social, e.nombre_comercial, '—') AS deudor,
                COALESCE(CAST(c.dni AS TEXT), e.ruc, '') AS documento
           FROM cuentas_por_cobrar cxc
           LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
           LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
          WHERE cxc.id_cxc = $1`,
        [idCxc],
      ),
      this.dataSource.query(
        `SELECT a.*, m.nombre AS metodo
           FROM abonos_credito a
           LEFT JOIN metodos_pago m ON m.id_metodo = a.id_metodo
          WHERE a.id_cxc = $1
          ORDER BY a.id_abono DESC`,
        [idCxc],
      ),
    ]);
    if (!filas[0]) return null;
    return { ...filas[0], abonos };
  }

  /**
   * Registra el abono con aritmética en céntimos y devuelve la cuenta ya actualizada
   * (leída después del COMMIT; antes se leía con otra conexión y salía el saldo viejo).
   */
  async registrarAbono(datos: {
    id_cxc: number;
    monto: number;
    id_metodo?: number;
    referencia?: string;
    id_usuario?: number;
  }) {
    await this.exigirEsquema();
    await this.dataSource.transaction(async (manager) => {
      const filas = await manager.query(
        `SELECT id_cxc, estado, saldo::text AS saldo FROM cuentas_por_cobrar WHERE id_cxc = $1 FOR UPDATE`,
        [datos.id_cxc],
      );
      const cxc = filas[0];
      if (!cxc) throw new Error('CxC_NO_ENCONTRADA');
      if (['pagado', 'anulado'].includes(cxc.estado)) throw new Error('CxC_CERRADA');

      const monto = Dinero.desdeNumeroRedondeado(Number(datos.monto));
      const saldo = Dinero.desdeBd(cxc.saldo);
      // Holgura de 5 céntimos por redondeos al cobrar.
      if (!monto.esPositivo() || monto.centimos > saldo.centimos + 5) throw new Error('CxC_MONTO_INVALIDO');

      await manager.query(
        `INSERT INTO abonos_credito (id_cxc, id_metodo, monto, referencia, id_usuario)
         VALUES ($1, $2, $3::numeric, $4, $5)`,
        [
          datos.id_cxc,
          datos.id_metodo ?? null,
          monto.aTexto(),
          (datos.referencia ?? '').trim() || null,
          datos.id_usuario ?? null,
        ],
      );

      const restante = saldo.restar(monto);
      const pagado = restante.centimos <= 5;
      await manager.query(
        `UPDATE cuentas_por_cobrar
            SET saldo = $1::numeric,
                estado = CASE
                  WHEN $2::boolean THEN 'pagado'
                  WHEN fecha_vencimiento < ${SQL_HOY_LIMA} THEN 'vencido'
                  ELSE 'parcial'
                END
          WHERE id_cxc = $3`,
        [pagado ? '0.00' : restante.aTexto(), pagado, datos.id_cxc],
      );
    });
    return this.obtener(datos.id_cxc);
  }

  /**
   * Persiste el estado 'vencido' (hora de Lima). Lo llama la tarea programada; con varias
   * réplicas solo una lo hace (pg_try_advisory_xact_lock). Devuelve cuántas cuentas cambió.
   */
  async marcarVencidas(): Promise<number> {
    if (!(await this.esquema.tiene('credito'))) return 0;
    return this.dataSource.transaction(async (manager) => {
      const candado = await manager.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [CANDADO_VENCIMIENTOS]);
      if (!candado[0]?.ok) return 0;
      const filas = filasDe(await manager.query(
        `UPDATE cuentas_por_cobrar
            SET estado = 'vencido'
          WHERE estado IN ('pendiente', 'parcial')
            AND saldo > 0
            AND fecha_vencimiento < ${SQL_HOY_LIMA}
          RETURNING id_cxc`,
      ));
      return filas.length;
    });
  }

  async actualizarLineaCliente(
    idCliente: number,
    datos: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
  ) {
    await this.exigirEsquema();
    const filas = filasDe(await this.dataSource.query(
      `UPDATE clientes SET
         credito_activo = COALESCE($2, credito_activo),
         limite_credito = COALESCE($3::numeric, limite_credito),
         dias_credito = COALESCE($4, dias_credito)
       WHERE id_cliente = $1
       RETURNING id_cliente`,
      [
        idCliente,
        datos.credito_activo === undefined ? null : datos.credito_activo,
        datos.limite_credito === undefined ? null : Dinero.desdeNumeroRedondeado(datos.limite_credito).aTexto(),
        datos.dias_credito === undefined ? null : datos.dias_credito,
      ],
    ));
    if (!filas[0]) return null;
    return this.lineaCliente(idCliente);
  }

  async actualizarLineaEmpresa(
    idEmpresa: number,
    datos: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
  ) {
    await this.exigirEsquema();
    const filas = filasDe(await this.dataSource.query(
      `UPDATE empresas SET
         credito_activo = COALESCE($2, credito_activo),
         limite_credito = COALESCE($3::numeric, limite_credito),
         dias_credito = COALESCE($4, dias_credito)
       WHERE id_empresa = $1
       RETURNING id_empresa`,
      [
        idEmpresa,
        datos.credito_activo === undefined ? null : datos.credito_activo,
        datos.limite_credito === undefined ? null : Dinero.desdeNumeroRedondeado(datos.limite_credito).aTexto(),
        datos.dias_credito === undefined ? null : datos.dias_credito,
      ],
    ));
    if (!filas[0]) return null;
    return this.lineaEmpresa(idEmpresa);
  }
}
