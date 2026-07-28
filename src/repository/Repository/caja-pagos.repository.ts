import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pasarelaConfig } from '../../config/pasarela.config';

@Injectable()
export class CajaPagosRepository implements OnModuleInit {
  private readonly log = new Logger(CajaPagosRepository.name);
  private listo = false;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.asegurarSchema();
  }

  async asegurarSchema(): Promise<void> {
    if (this.listo) return;
    try {
      const sql = readFileSync(join(process.cwd(), 'sql', 'cuentas_bancarias_pos.sql'), 'utf8');
      await this.dataSource.query(sql);
      this.listo = true;
    } catch (error: any) {
      this.log.warn(`SQL cuentas_bancarias: ${error?.message}. DDL mínimo…`);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS cuentas_bancarias (
          id_cuenta SERIAL PRIMARY KEY,
          banco VARCHAR(80) NOT NULL,
          alias VARCHAR(80),
          tipo_cuenta VARCHAR(40) DEFAULT 'ahorros',
          numero_cuenta VARCHAR(40),
          cci VARCHAR(30),
          titular VARCHAR(120),
          moneda VARCHAR(3) DEFAULT 'PEN',
          activo BOOLEAN DEFAULT TRUE,
          es_yape BOOLEAN DEFAULT FALSE,
          orden INTEGER DEFAULT 0,
          creado_en TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS id_cuenta_bancaria INTEGER;
        ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS voucher_pos VARCHAR(80);
        ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS validacion VARCHAR(40);
        ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS referencia_externa VARCHAR(120);
      `);
      this.listo = true;
    }
  }

  async listarCuentas(soloActivas = true) {
    await this.asegurarSchema();
    return this.dataSource.query(
      `SELECT * FROM cuentas_bancarias
        WHERE ($1::boolean = FALSE OR COALESCE(activo, TRUE) = TRUE)
        ORDER BY COALESCE(orden, id_cuenta), id_cuenta`,
      [soloActivas],
    );
  }

  async crearCuenta(body: any) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `INSERT INTO cuentas_bancarias
         (banco, alias, tipo_cuenta, numero_cuenta, cci, titular, moneda, activo, es_yape, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,TRUE),COALESCE($9,FALSE),COALESCE($10,0))
       RETURNING *`,
      [
        String(body.banco ?? '').trim(),
        (body.alias ?? '').trim() || null,
        (body.tipo_cuenta ?? 'ahorros').trim(),
        (body.numero_cuenta ?? '').trim() || null,
        (body.cci ?? '').trim() || null,
        (body.titular ?? '').trim() || null,
        (body.moneda ?? 'PEN').trim(),
        body.activo !== false,
        Boolean(body.es_yape),
        Number(body.orden) || 0,
      ],
    );
    return filas[0];
  }

  async actualizarCuenta(id: number, body: any) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `UPDATE cuentas_bancarias SET
         banco = COALESCE($2, banco),
         alias = COALESCE($3, alias),
         tipo_cuenta = COALESCE($4, tipo_cuenta),
         numero_cuenta = COALESCE($5, numero_cuenta),
         cci = COALESCE($6, cci),
         titular = COALESCE($7, titular),
         moneda = COALESCE($8, moneda),
         activo = COALESCE($9, activo),
         es_yape = COALESCE($10, es_yape),
         orden = COALESCE($11, orden)
       WHERE id_cuenta = $1
       RETURNING *`,
      [
        id,
        body.banco !== undefined ? String(body.banco).trim() : null,
        body.alias !== undefined ? String(body.alias).trim() : null,
        body.tipo_cuenta !== undefined ? String(body.tipo_cuenta).trim() : null,
        body.numero_cuenta !== undefined ? String(body.numero_cuenta).trim() : null,
        body.cci !== undefined ? String(body.cci).trim() : null,
        body.titular !== undefined ? String(body.titular).trim() : null,
        body.moneda !== undefined ? String(body.moneda).trim() : null,
        body.activo !== undefined ? Boolean(body.activo) : null,
        body.es_yape !== undefined ? Boolean(body.es_yape) : null,
        body.orden !== undefined ? Number(body.orden) : null,
      ],
    );
    return filas[0] ?? null;
  }

  async eliminarCuenta(id: number) {
    await this.asegurarSchema();
    // Soft delete para no romper ventas históricas
    await this.dataSource.query(
      `UPDATE cuentas_bancarias SET activo = FALSE WHERE id_cuenta = $1`,
      [id],
    );
    return { deleted: true, id_cuenta: id };
  }

  /** Estado Culqi / pasarela para el POS. */
  pasarelaPos() {
    const culqiOk = pasarelaConfig.proveedor === 'culqi' && !!pasarelaConfig.culqi.secretKey;
    return {
      proveedor: pasarelaConfig.proveedor,
      culqi_habilitado: culqiOk,
      llave_publica: culqiOk ? pasarelaConfig.culqi.publicKey : null,
      yape_validacion: culqiOk ? 'culqi' : 'manual',
      tarjeta_modo: 'pos_fisico',
      mensaje_tarjeta:
        'Cobra en la maquinita POS y registra el N° de voucher. La boleta/factura la emite Hatunsales.',
    };
  }

  async crearOrdenCulqi(params: {
    monto: number;
    descripcion: string;
    email?: string;
    orderNumber: string;
  }) {
    const { url, secretKey, timeoutMs } = pasarelaConfig.culqi;
    if (!secretKey) throw new Error('CULQI_NO_CONFIG');

    const expiracion = Math.floor(Date.now() / 1000) + 60 * 30; // 30 min
    const cuerpo = {
      amount: Math.round(params.monto * 100),
      currency_code: 'PEN',
      description: params.descripcion.slice(0, 80),
      order_number: params.orderNumber.slice(0, 20),
      client_details: {
        email: params.email || 'caja@hatunsales.com',
      },
      expiration_date: expiracion,
      confirm: false,
      metadata: { origen: 'pos_mostrador' },
    };

    const control = new AbortController();
    const t = setTimeout(() => control.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey}`,
        },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      });
      const datos: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(datos?.merchant_message || datos?.user_message || 'No se pudo crear la orden Yape');
      }
      return {
        order_id: datos.id,
        order_number: datos.order_number,
        amount: Number(datos.amount) / 100,
        currency: datos.currency_code,
        expiration_date: datos.expiration_date,
        payment_code: datos.payment_code ?? null,
        qr: datos.qr ?? datos?.payment_code ?? null,
        crudo: datos,
      };
    } finally {
      clearTimeout(t);
    }
  }

  async consultarOrdenCulqi(orderId: string) {
    const { url, secretKey, timeoutMs } = pasarelaConfig.culqi;
    if (!secretKey) throw new Error('CULQI_NO_CONFIG');

    const control = new AbortController();
    const t = setTimeout(() => control.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/orders/${orderId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: control.signal,
      });
      const datos: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(datos?.merchant_message || 'No se pudo consultar la orden');
      }
      const estado = String(datos.state ?? datos.order_state ?? '').toLowerCase();
      const pagado =
        estado.includes('paid') ||
        estado.includes('pagad') ||
        datos?.outcome?.type === 'venta_exitosa' ||
        Number(datos?.total_paid ?? 0) > 0;

      return {
        order_id: datos.id,
        estado,
        pagado,
        amount: datos.amount ? Number(datos.amount) / 100 : undefined,
        crudo: datos,
      };
    } finally {
      clearTimeout(t);
    }
  }
}
