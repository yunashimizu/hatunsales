import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheTtl } from '../sunat/config/cache-ttl';
import { filasDe } from '../sunat/config/transacciones-fiscales';
import { TIPO_BOLETA, TIPO_FACTURA } from '../util/fiscal/tipos-comprobante';

export type EstadoCorreo = 'PENDIENTE' | 'ENVIANDO' | 'ENVIADO' | 'ERROR' | 'OMITIDO';
export type OrigenCorreo = 'automatico' | 'manual';

export interface CorreoFila {
  id_correo: number;
  id_comprobante: number;
  destino: string | null;
  estado: EstadoCorreo;
  origen: OrigenCorreo;
  intentos: number;
  proximo_intento_en: string | null;
  ultimo_error: string | null;
  id_mensaje_proveedor: string | null;
  motivo_omision: string | null;
  id_usuario: number | null;
  creado_en: string;
  enviado_en: string | null;
}

/** Plazo del reclamo: mientras dura, ninguna otra réplica toma el mismo correo. */
export const SEGUNDOS_RECLAMO_CORREO = 60;
/** Solo se siembran comprobantes recientes: al encender el interruptor no se escribe a clientes de hace meses. */
export const DIAS_SIEMBRA_CORREO = 7;

const COLUMNAS = `
  t.id_correo, t.id_comprobante, t.destino, t.estado, t.origen, t.intentos, t.proximo_intento_en,
  t.ultimo_error, t.id_mensaje_proveedor, t.motivo_omision, t.id_usuario, t.creado_en, t.enviado_en`;

/** Correo con formato razonable (misma idea que correoValido en correo.config.ts), evaluado en SQL. */
const CORREO_VALIDO_SQL = `(length(btrim(c.cliente_email)) <= 254 AND btrim(c.cliente_email) ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$')`;

const ACEPTADOS_SQL = `c.estado_sunat IN ('ACEPTADO', 'ACEPTADO_OBS')`;

/** Persistencia de la cola de correos (tabla comprobante_correos, sql/fase17). Solo SQL con parámetros $n. */
@Injectable()
export class ComprobanteCorreosRepository {
  private readonly esquema = new CacheTtl<boolean>((existe) => (existe ? 10 * 60_000 : 60_000));

  constructor(@InjectDataSource('pgConnection') private readonly bd: DataSource) {}

  /** ¿Existe la tabla? (se pregunta una vez cada 10 min si existe, cada minuto si no). */
  tablaDisponible(): Promise<boolean> {
    return this.esquema.obtener('tabla', async () => {
      try {
        const filas = filasDe<{ existe: boolean }>(
          await this.bd.query(`SELECT to_regclass('public.comprobante_correos') IS NOT NULL AS existe`),
        );
        return filas[0]?.existe === true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Crea la fila automática de los comprobantes con enviar_cliente que aún no tienen ninguna fila (si el personal ya pidió un reenvío, no se siembra): PENDIENTE, u OMITIDO si
   * no son de envío directo a SUNAT o no tienen un correo válido. No siembra rechazados ni anulados.
   */
  async sembrar(limite: number): Promise<number> {
    const filas = filasDe<{ id_correo: number }>(
      await this.bd.query(
        `INSERT INTO comprobante_correos (id_comprobante, destino, estado, origen, motivo_omision)
         SELECT c.id_comprobante,
                NULLIF(btrim(c.cliente_email), ''),
                CASE WHEN c.proveedor_fiscal IS DISTINCT FROM 'sunat_directo' THEN 'OMITIDO'
                     WHEN c.cliente_email IS NULL OR btrim(c.cliente_email) = '' THEN 'OMITIDO'
                     WHEN ${CORREO_VALIDO_SQL} THEN 'PENDIENTE'
                     ELSE 'OMITIDO' END,
                'automatico',
                CASE WHEN c.proveedor_fiscal IS DISTINCT FROM 'sunat_directo' THEN 'sin comprobante electrónico'
                     WHEN c.cliente_email IS NULL OR btrim(c.cliente_email) = '' THEN 'el cliente no tiene correo'
                     WHEN ${CORREO_VALIDO_SQL} THEN NULL
                     ELSE 'correo del cliente no válido' END
           FROM comprobantes c
          WHERE c.enviar_cliente = true
            AND c.id_tipo = ANY($1::int[])
            AND COALESCE(c.anulado, false) = false
            AND COALESCE(c.estado_sunat, '') NOT IN ('RECHAZADO', 'ANULADO')
            AND c.creado_en >= NOW() - ($2::int * INTERVAL '1 day')
            AND NOT EXISTS (SELECT 1 FROM comprobante_correos x WHERE x.id_comprobante = c.id_comprobante)
          ORDER BY c.id_comprobante
          LIMIT $3
         ON CONFLICT (id_comprobante) WHERE origen = 'automatico' DO NOTHING
         RETURNING id_correo`,
        [[TIPO_FACTURA, TIPO_BOLETA], DIAS_SIEMBRA_CORREO, Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.length;
  }

  /** Pasa a OMITIDO los pendientes cuyo comprobante quedó rechazado o anulado. */
  async omitirRechazados(): Promise<number> {
    const filas = filasDe<{ id_correo: number }>(
      await this.bd.query(
        `UPDATE comprobante_correos t
            SET estado = 'OMITIDO', motivo_omision = 'comprobante rechazado o anulado', bloqueado_hasta = NULL, actualizado_en = NOW()
           FROM comprobantes c
          WHERE c.id_comprobante = t.id_comprobante AND t.estado = 'PENDIENTE'
            AND (COALESCE(c.anulado, false) = true OR COALESCE(c.estado_sunat, '') IN ('RECHAZADO', 'ANULADO'))
          RETURNING t.id_correo`,
      ),
    );
    return filas.length;
  }

  /** Pendientes con el comprobante aceptado y no anulado, con el turno vencido y sin reclamo vigente (o ENVIANDO con reclamo vencido). */
  async candidatos(limite: number): Promise<number[]> {
    const filas = filasDe<{ id_correo: number }>(
      await this.bd.query(
        `SELECT t.id_correo
           FROM comprobante_correos t
           JOIN comprobantes c ON c.id_comprobante = t.id_comprobante
          WHERE (t.estado = 'PENDIENTE' OR t.estado = 'ENVIANDO')
            AND ${ACEPTADOS_SQL} AND COALESCE(c.anulado, false) = false
            AND (t.proximo_intento_en IS NULL OR t.proximo_intento_en <= NOW())
            AND (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW())
          ORDER BY COALESCE(t.proximo_intento_en, t.creado_en), t.id_correo
          LIMIT $1`,
        [Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.map((f) => Number(f.id_correo));
  }

  /** Reclama el correo para esta réplica (SKIP LOCKED + plazo). null si otra lo tomó o ya cambió de estado. */
  async reclamar(idCorreo: number): Promise<CorreoFila | null> {
    const filas = filasDe<CorreoFila>(
      await this.bd.query(
        `UPDATE comprobante_correos t
            SET estado = 'ENVIANDO', intentos = t.intentos + 1,
                bloqueado_hasta = NOW() + ($2::int * INTERVAL '1 second'), actualizado_en = NOW()
          WHERE t.id_correo = (
                  SELECT s.id_correo FROM comprobante_correos s
                   WHERE s.id_correo = $1 AND s.estado IN ('PENDIENTE', 'ENVIANDO')
                     AND (s.bloqueado_hasta IS NULL OR s.bloqueado_hasta < NOW())
                   FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNAS}`,
        [idCorreo, SEGUNDOS_RECLAMO_CORREO],
      ),
    );
    return filas[0] ?? null;
  }

  /** `destino` solo se pasa cuando el correo salió a otra dirección (BETA: la de pruebas). */
  async marcarEnviado(idCorreo: number, idMensaje: string | null, destino: string | null = null): Promise<void> {
    await this.bd.query(
      `UPDATE comprobante_correos
          SET estado = 'ENVIADO', id_mensaje_proveedor = $2, destino = COALESCE($3, destino), enviado_en = NOW(), ultimo_error = NULL,
              proximo_intento_en = NULL, bloqueado_hasta = NULL, actualizado_en = NOW()
        WHERE id_correo = $1`,
      [idCorreo, idMensaje ? idMensaje.slice(0, 120) : null, destino],
    );
  }

  /** Con minutosEspera vuelve a PENDIENTE para un nuevo intento; con null queda en ERROR definitivo. */
  async marcarError(idCorreo: number, mensaje: string, minutosEspera: number | null): Promise<void> {
    await this.bd.query(
      `UPDATE comprobante_correos
          SET estado = CASE WHEN $3::int IS NULL THEN 'ERROR' ELSE 'PENDIENTE' END,
              ultimo_error = $2,
              proximo_intento_en = CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() + ($3::int * INTERVAL '1 minute') END,
              bloqueado_hasta = NULL, actualizado_en = NOW()
        WHERE id_correo = $1`,
      [idCorreo, mensaje.slice(0, 1000), minutosEspera],
    );
  }

  async marcarOmitido(idCorreo: number, motivo: string): Promise<void> {
    await this.bd.query(
      `UPDATE comprobante_correos
          SET estado = 'OMITIDO', motivo_omision = $2, proximo_intento_en = NULL, bloqueado_hasta = NULL, actualizado_en = NOW()
        WHERE id_correo = $1`,
      [idCorreo, motivo.slice(0, 200)],
    );
  }

  /** Historial del comprobante, lo más reciente primero. */
  async historial(idComprobante: number): Promise<CorreoFila[]> {
    return filasDe<CorreoFila>(
      await this.bd.query(
        `SELECT ${COLUMNAS} FROM comprobante_correos t WHERE t.id_comprobante = $1 ORDER BY t.id_correo DESC LIMIT 50`,
        [idComprobante],
      ),
    );
  }

  /** Último correo del comprobante (el que resume su estado en el detalle). */
  async ultimo(idComprobante: number): Promise<CorreoFila | null> {
    const filas = filasDe<CorreoFila>(
      await this.bd.query(
        `SELECT ${COLUMNAS} FROM comprobante_correos t WHERE t.id_comprobante = $1 ORDER BY t.id_correo DESC LIMIT 1`,
        [idComprobante],
      ),
    );
    return filas[0] ?? null;
  }

  async obtener(idCorreo: number): Promise<CorreoFila | null> {
    const filas = filasDe<CorreoFila>(
      await this.bd.query(`SELECT ${COLUMNAS} FROM comprobante_correos t WHERE t.id_correo = $1`, [idCorreo]),
    );
    return filas[0] ?? null;
  }

  /** Reenvíos manuales de la última hora (para el límite de 3 por comprobante). */
  async reenviosUltimaHora(idComprobante: number): Promise<number> {
    const filas = filasDe<{ total: number }>(
      await this.bd.query(
        `SELECT COUNT(*)::int AS total FROM comprobante_correos
          WHERE id_comprobante = $1 AND origen = 'manual' AND creado_en >= NOW() - INTERVAL '1 hour'`,
        [idComprobante],
      ),
    );
    return Number(filas[0]?.total ?? 0);
  }

  /** Crea un reenvío manual PENDIENTE. null si el comprobante ya tiene un envío abierto (PENDIENTE/ENVIANDO). */
  async crearManual(idComprobante: number, destino: string, idUsuario: number | null): Promise<number | null> {
    const filas = filasDe<{ id_correo: number }>(
      await this.bd.query(
        `INSERT INTO comprobante_correos (id_comprobante, destino, estado, origen, id_usuario)
         VALUES ($1, $2, 'PENDIENTE', 'manual', $3)
         ON CONFLICT (id_comprobante) WHERE estado IN ('PENDIENTE', 'ENVIANDO') DO NOTHING
         RETURNING id_correo`,
        [idComprobante, destino, idUsuario],
      ),
    );
    return filas[0] ? Number(filas[0].id_correo) : null;
  }
}
