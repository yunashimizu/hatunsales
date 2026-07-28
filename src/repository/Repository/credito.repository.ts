import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface LineaCredito {
  credito_activo: boolean;
  limite_credito: number;
  dias_credito: number;
  saldo_pendiente: number;
  disponible: number;
  denominacion: string;
}

@Injectable()
export class CreditoRepository implements OnModuleInit {
  private readonly log = new Logger(CreditoRepository.name);
  private schemaListo = false;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.asegurarSchema();
  }

  async asegurarSchema(): Promise<void> {
    if (this.schemaListo) return;
    try {
      const sqlPath = join(process.cwd(), 'sql', 'credito_cxc.sql');
      const sql = readFileSync(sqlPath, 'utf8');
      await this.dataSource.query(sql);
      this.schemaListo = true;
      this.log.log('Schema de crédito / CxC listo');
    } catch (error: any) {
      // Fallback mínimo si el archivo no está en el despliegue
      this.log.warn(`No se pudo aplicar sql/credito_cxc.sql (${error?.message}). Intentando DDL mínimo…`);
      try {
        await this.dataSource.query(`
          ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS referencia VARCHAR(120);
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS credito_activo BOOLEAN DEFAULT FALSE;
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12,2) DEFAULT 0;
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS dias_credito INTEGER DEFAULT 15;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS credito_activo BOOLEAN DEFAULT FALSE;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12,2) DEFAULT 0;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS dias_credito INTEGER DEFAULT 15;
          CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
            id_cxc SERIAL PRIMARY KEY,
            id_venta INTEGER NOT NULL,
            id_cliente INTEGER,
            id_empresa INTEGER,
            monto_total NUMERIC(12,2) NOT NULL,
            saldo NUMERIC(12,2) NOT NULL,
            fecha_emision TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            fecha_vencimiento DATE NOT NULL,
            estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS abonos_credito (
            id_abono SERIAL PRIMARY KEY,
            id_cxc INTEGER NOT NULL,
            id_metodo INTEGER,
            monto NUMERIC(12,2) NOT NULL,
            referencia VARCHAR(120),
            id_usuario INTEGER,
            creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          INSERT INTO metodos_pago (nombre, tipo, descripcion, activo, orden)
          SELECT 'Efectivo', 'efectivo', 'Pago en efectivo en caja', TRUE, 1
          WHERE NOT EXISTS (SELECT 1 FROM metodos_pago WHERE LOWER(TRIM(nombre)) = 'efectivo');
          INSERT INTO metodos_pago (nombre, tipo, descripcion, activo, orden)
          SELECT 'Crédito', 'credito', 'Venta a crédito', TRUE, 90
          WHERE NOT EXISTS (
            SELECT 1 FROM metodos_pago
             WHERE LOWER(TRIM(COALESCE(tipo,''))) = 'credito'
                OR LOWER(TRIM(nombre)) IN ('crédito','credito')
          );
        `);
        this.schemaListo = true;
      } catch (e: any) {
        this.log.error(`DDL crédito falló: ${e?.message}`);
      }
    }
  }

  async idMetodoCredito(): Promise<number | null> {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `SELECT id_metodo FROM metodos_pago
        WHERE COALESCE(activo, TRUE) = TRUE
          AND (LOWER(TRIM(COALESCE(tipo,''))) = 'credito'
            OR LOWER(TRIM(nombre)) IN ('crédito', 'credito'))
        ORDER BY id_metodo LIMIT 1`,
    );
    return filas[0]?.id_metodo ? Number(filas[0].id_metodo) : null;
  }

  async metodosConTipo(): Promise<{ id_metodo: number; nombre: string; tipo: string }[]> {
    await this.asegurarSchema();
    return this.dataSource.query(
      `SELECT id_metodo, nombre, COALESCE(tipo, '') AS tipo
         FROM metodos_pago
        WHERE COALESCE(activo, TRUE) = TRUE
        ORDER BY COALESCE(orden, id_metodo), id_metodo`,
    );
  }

  async lineaCliente(idCliente: number): Promise<LineaCredito | null> {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `SELECT c.id_cliente,
              COALESCE(c.credito_activo, FALSE) AS credito_activo,
              COALESCE(c.limite_credito, 0)::float AS limite_credito,
              COALESCE(c.dias_credito, 15)::int AS dias_credito,
              COALESCE(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), c.nombre, '') AS denominacion,
              COALESCE((
                SELECT SUM(cxc.saldo)::float FROM cuentas_por_cobrar cxc
                 WHERE cxc.id_cliente = c.id_cliente
                   AND cxc.estado IN ('pendiente', 'parcial', 'vencido')
              ), 0) AS saldo_pendiente
         FROM clientes c WHERE c.id_cliente = $1`,
      [idCliente],
    );
    if (!filas[0]) return null;
    return this.mapLinea(filas[0]);
  }

  async lineaEmpresa(idEmpresa: number): Promise<LineaCredito | null> {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `SELECT e.id_empresa,
              COALESCE(e.credito_activo, FALSE) AS credito_activo,
              COALESCE(e.limite_credito, 0)::float AS limite_credito,
              COALESCE(e.dias_credito, 15)::int AS dias_credito,
              COALESCE(e.razon_social, e.nombre_comercial, e.ruc) AS denominacion,
              COALESCE((
                SELECT SUM(cxc.saldo)::float FROM cuentas_por_cobrar cxc
                 WHERE cxc.id_empresa = e.id_empresa
                   AND cxc.estado IN ('pendiente', 'parcial', 'vencido')
              ), 0) AS saldo_pendiente
         FROM empresas e WHERE e.id_empresa = $1`,
      [idEmpresa],
    );
    if (!filas[0]) return null;
    return this.mapLinea(filas[0]);
  }

  private mapLinea(row: any): LineaCredito {
    const limite = Number(row.limite_credito ?? 0);
    const saldo = Number(row.saldo_pendiente ?? 0);
    const activo = row.credito_activo === true || row.credito_activo === 't' || row.credito_activo === true;
    return {
      credito_activo: Boolean(activo),
      limite_credito: limite,
      dias_credito: Number(row.dias_credito ?? 15) || 15,
      saldo_pendiente: saldo,
      disponible: Math.max(0, limite - saldo),
      denominacion: String(row.denominacion ?? ''),
    };
  }

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
    const vencimiento = new Date();
    vencimiento.setDate(vencimiento.getDate() + Math.max(1, datos.dias));
    const fecha = vencimiento.toISOString().slice(0, 10);

    const filas = await manager.query(
      `INSERT INTO cuentas_por_cobrar
         (id_venta, id_cliente, id_empresa, monto_total, saldo, fecha_emision, fecha_vencimiento, estado)
       VALUES ($1, $2, $3, $4, $4, NOW(), $5::date, 'pendiente')
       RETURNING id_cxc`,
      [
        datos.id_venta,
        datos.id_cliente ?? null,
        datos.id_empresa ?? null,
        datos.monto,
        fecha,
      ],
    );
    return Number(filas[0].id_cxc);
  }

  async listar(filtros: {
    estado?: string;
    texto?: string;
    pagina?: number;
    limite?: number;
  }) {
    await this.asegurarSchema();
    // Marcar vencidos
    await this.dataSource.query(
      `UPDATE cuentas_por_cobrar
          SET estado = 'vencido'
        WHERE estado IN ('pendiente', 'parcial')
          AND fecha_vencimiento < CURRENT_DATE
          AND saldo > 0`,
    );

    const pagina = Math.max(1, Number(filtros.pagina) || 1);
    const limite = Math.min(100, Math.max(1, Number(filtros.limite) || 20));
    const offset = (pagina - 1) * limite;
    const params: any[] = [];
    const where: string[] = ['1=1'];

    if (filtros.estado) {
      params.push(filtros.estado);
      where.push(`cxc.estado = $${params.length}`);
    }
    if (filtros.texto?.trim()) {
      params.push(`%${filtros.texto.trim().toLowerCase()}%`);
      where.push(`(
        LOWER(COALESCE(c.nombre, '')) LIKE $${params.length}
        OR LOWER(COALESCE(e.razon_social, '')) LIKE $${params.length}
        OR CAST(cxc.id_venta AS TEXT) LIKE $${params.length}
      )`);
    }

    const whereSql = where.join(' AND ');
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
         FROM cuentas_por_cobrar cxc
         LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
        WHERE ${whereSql}`,
      params,
    );

    params.push(limite, offset);
    const data = await this.dataSource.query(
      `SELECT cxc.*,
              COALESCE(c.nombre, e.razon_social, e.nombre_comercial, '—') AS deudor,
              COALESCE(CAST(c.dni AS TEXT), e.ruc, '') AS documento
         FROM cuentas_por_cobrar cxc
         LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
        WHERE ${whereSql}
        ORDER BY cxc.fecha_vencimiento ASC, cxc.id_cxc DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { data, total: Number(total), pagina, limite };
  }

  async obtener(idCxc: number) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `SELECT cxc.*,
              COALESCE(c.nombre, e.razon_social, e.nombre_comercial, '—') AS deudor,
              COALESCE(CAST(c.dni AS TEXT), e.ruc, '') AS documento
         FROM cuentas_por_cobrar cxc
         LEFT JOIN clientes c ON c.id_cliente = cxc.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = cxc.id_empresa
        WHERE cxc.id_cxc = $1`,
      [idCxc],
    );
    if (!filas[0]) return null;

    const abonos = await this.dataSource.query(
      `SELECT a.*, m.nombre AS metodo
         FROM abonos_credito a
         LEFT JOIN metodos_pago m ON m.id_metodo = a.id_metodo
        WHERE a.id_cxc = $1
        ORDER BY a.id_abono DESC`,
      [idCxc],
    );

    return { ...filas[0], abonos };
  }

  async registrarAbono(datos: {
    id_cxc: number;
    monto: number;
    id_metodo?: number;
    referencia?: string;
    id_usuario?: number;
  }) {
    await this.asegurarSchema();
    return this.dataSource.transaction(async (manager) => {
      const filas = await manager.query(
        `SELECT * FROM cuentas_por_cobrar WHERE id_cxc = $1 FOR UPDATE`,
        [datos.id_cxc],
      );
      const cxc = filas[0];
      if (!cxc) throw new Error('CxC_NO_ENCONTRADA');
      if (['pagado', 'anulado'].includes(cxc.estado)) throw new Error('CxC_CERRADA');

      const monto = Number(datos.monto);
      const saldo = Number(cxc.saldo);
      if (monto <= 0 || monto > saldo + 0.05) throw new Error('CxC_MONTO_INVALIDO');

      await manager.query(
        `INSERT INTO abonos_credito (id_cxc, id_metodo, monto, referencia, id_usuario)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          datos.id_cxc,
          datos.id_metodo ?? null,
          monto,
          (datos.referencia ?? '').trim() || null,
          datos.id_usuario ?? null,
        ],
      );

      const nuevoSaldo = Math.max(0, Math.round((saldo - monto) * 100) / 100);
      let estado = nuevoSaldo <= 0.05 ? 'pagado' : 'parcial';
      if (estado !== 'pagado' && new Date(cxc.fecha_vencimiento) < new Date(new Date().toDateString())) {
        estado = 'vencido';
      }

      await manager.query(
        `UPDATE cuentas_por_cobrar SET saldo = $1, estado = $2 WHERE id_cxc = $3`,
        [nuevoSaldo <= 0.05 ? 0 : nuevoSaldo, estado, datos.id_cxc],
      );

      return this.obtener(datos.id_cxc);
    });
  }

  async actualizarLineaCliente(
    idCliente: number,
    datos: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
  ) {
    await this.asegurarSchema();
    await this.dataSource.query(
      `UPDATE clientes SET
         credito_activo = COALESCE($2, credito_activo),
         limite_credito = COALESCE($3, limite_credito),
         dias_credito = COALESCE($4, dias_credito)
       WHERE id_cliente = $1`,
      [
        idCliente,
        datos.credito_activo === undefined ? null : datos.credito_activo,
        datos.limite_credito === undefined ? null : datos.limite_credito,
        datos.dias_credito === undefined ? null : datos.dias_credito,
      ],
    );
    return this.lineaCliente(idCliente);
  }

  async actualizarLineaEmpresa(
    idEmpresa: number,
    datos: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
  ) {
    await this.asegurarSchema();
    await this.dataSource.query(
      `UPDATE empresas SET
         credito_activo = COALESCE($2, credito_activo),
         limite_credito = COALESCE($3, limite_credito),
         dias_credito = COALESCE($4, dias_credito)
       WHERE id_empresa = $1`,
      [
        idEmpresa,
        datos.credito_activo === undefined ? null : datos.credito_activo,
        datos.limite_credito === undefined ? null : datos.limite_credito,
        datos.dias_credito === undefined ? null : datos.dias_credito,
      ],
    );
    return this.lineaEmpresa(idEmpresa);
  }
}
