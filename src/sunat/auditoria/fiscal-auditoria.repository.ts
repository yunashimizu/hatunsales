import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { EjecutorSql } from '../config/transacciones-fiscales';

/**
 * Bitácora fiscal en PostgreSQL (`fiscal_auditoria`): quién cambió el
 * proveedor, el ambiente, el certificado o las credenciales, cuándo y desde
 * qué IP. Nunca guarda secretos: el detalle pasa por `sanitizarDetalle`.
 */

export const ACCIONES_AUDITORIA_FISCAL = {
  PROVEEDOR_CAMBIADO: 'PROVEEDOR_CAMBIADO',
  AMBIENTE_CAMBIADO: 'AMBIENTE_CAMBIADO',
  CONFIG_OPERACION: 'CONFIG_OPERACION',
  CONFIG_EMISOR: 'CONFIG_EMISOR',
  SERIES: 'SERIES',
  CRED_SOL_ACTUALIZADA: 'CRED_SOL_ACTUALIZADA',
  CRED_SOL_ELIMINADA: 'CRED_SOL_ELIMINADA',
  CRED_GRE_ACTUALIZADA: 'CRED_GRE_ACTUALIZADA',
  CRED_GRE_ELIMINADA: 'CRED_GRE_ELIMINADA',
  CONFIG_GRE: 'CONFIG_GRE',
  CONFIRMACION_NO_OSE: 'CONFIRMACION_NO_OSE',
  CONFIRMACION_NO_OSE_RETIRADA: 'CONFIRMACION_NO_OSE_RETIRADA',
  CERT_SUBIDO: 'CERT_SUBIDO',
  CERT_REEMPLAZADO: 'CERT_REEMPLAZADO',
  CERT_ELIMINADO: 'CERT_ELIMINADO',
  CERT_AUTOFIRMADO_GENERADO: 'CERT_AUTOFIRMADO_GENERADO',
  CERT_RECIFRADO: 'CERT_RECIFRADO',
  PRUEBA_CONEXION: 'PRUEBA_CONEXION',
} as const;
export type AccionAuditoriaFiscal = (typeof ACCIONES_AUDITORIA_FISCAL)[keyof typeof ACCIONES_AUDITORIA_FISCAL];

export interface EventoAuditoriaFiscal {
  /** Una de ACCIONES_AUDITORIA_FISCAL (otras fases pueden usar las suyas). */
  accion: AccionAuditoriaFiscal | string;
  id_usuario?: number | null;
  entidad?: string | null;
  id_entidad?: string | number | null;
  detalle?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface RegistroAuditoriaFiscal {
  id_auditoria: number;
  creado_en: string;
  id_usuario: number | null;
  accion: string;
  entidad: string | null;
  id_entidad: string | null;
  detalle: Record<string, unknown> | null;
  ip: string | null;
}

const PATRON_SECRETO = /clave|password|passw|contrase|secret|token|pfx|privad|private|pem|cifrad|llave|key/i;
const MAX_TEXTO = 500;
const MAX_PROFUNDIDAD = 4;
const MAX_JSON = 8_000;

/** Quita recursivamente todo lo que parezca secreto y recorta textos largos. */
export function sanitizarDetalle(detalle: unknown, profundidad = 0): any {
  if (detalle === null || detalle === undefined) return null;
  if (profundidad > MAX_PROFUNDIDAD) return '[…]';
  if (Buffer.isBuffer(detalle)) return '[binario omitido]';
  if (detalle instanceof Date) return detalle.toISOString();
  if (typeof detalle === 'string') return detalle.length > MAX_TEXTO ? `${detalle.slice(0, MAX_TEXTO)}…` : detalle;
  if (typeof detalle !== 'object') return detalle;
  if (Array.isArray(detalle)) return detalle.slice(0, 50).map((v) => sanitizarDetalle(v, profundidad + 1));

  const limpio: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(detalle as Record<string, unknown>)) {
    // Las banderas booleanas (p. ej. tiene_clave) no revelan nada y se conservan.
    if (PATRON_SECRETO.test(clave) && typeof valor !== 'boolean') {
      limpio[clave] = '[omitido]';
      continue;
    }
    limpio[clave] = sanitizarDetalle(valor, profundidad + 1);
  }
  return limpio;
}

@Injectable()
export class FiscalAuditoriaRepository {
  private readonly logger = new Logger(FiscalAuditoriaRepository.name);
  private avisoTablaFaltante = false;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: FiscalEsquemaService,
  ) {}

  /**
   * Registra un evento. Dentro de una transacción (ejecutor) es atómico con el
   * cambio. Si la tabla aún no existe (fase 9 pendiente) solo avisa en el log:
   * la auditoría nunca tumba la operación principal.
   */
  async registrar(evento: EventoAuditoriaFiscal, ejecutor?: EjecutorSql): Promise<void> {
    if (!(await this.esquema.tiene('auditoria'))) {
      if (!this.avisoTablaFaltante) {
        this.avisoTablaFaltante = true;
        this.logger.warn('fiscal_auditoria no existe todavía (falta sql/fase9_sunat_directo.sql): los eventos solo van al log.');
      }
      this.logger.log(`Auditoría fiscal (sin tabla): ${evento.accion} por usuario ${evento.id_usuario ?? 'sistema'}`);
      return;
    }

    let detalle = sanitizarDetalle(evento.detalle ?? null);
    let json = detalle ? JSON.stringify(detalle) : null;
    if (json && json.length > MAX_JSON) {
      detalle = { resumen: `${json.slice(0, MAX_JSON - 100)}…`, recortado: true };
      json = JSON.stringify(detalle);
    }

    await (ejecutor ?? this.dataSource).query(
      `INSERT INTO fiscal_auditoria (id_usuario, accion, entidad, id_entidad, detalle, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        evento.id_usuario ?? null,
        String(evento.accion).slice(0, 60),
        evento.entidad ? String(evento.entidad).slice(0, 40) : null,
        evento.id_entidad === null || evento.id_entidad === undefined ? null : String(evento.id_entidad).slice(0, 40),
        json,
        evento.ip ? String(evento.ip).slice(0, 45) : null,
      ],
    );
  }

  /** Lo más reciente primero; `antesDe` pagina por id (keyset, sin OFFSET). */
  async listar(limite = 50, antesDe?: number | null): Promise<RegistroAuditoriaFiscal[]> {
    if (!(await this.esquema.tiene('auditoria'))) return [];
    const tope = Math.min(200, Math.max(1, Math.trunc(Number(limite) || 50)));
    const cursor = antesDe && Number.isFinite(Number(antesDe)) ? Math.trunc(Number(antesDe)) : null;

    const filas = await this.dataSource.query(
      `SELECT id_auditoria, creado_en, id_usuario, accion, entidad, id_entidad, detalle, ip
         FROM fiscal_auditoria
        WHERE ($1::bigint IS NULL OR id_auditoria < $1::bigint)
        ORDER BY id_auditoria DESC
        LIMIT $2`,
      [cursor, tope],
    );

    return filas.map((f: any) => ({
      id_auditoria: Number(f.id_auditoria),
      creado_en: f.creado_en instanceof Date ? f.creado_en.toISOString() : String(f.creado_en),
      id_usuario: f.id_usuario === null ? null : Number(f.id_usuario),
      accion: f.accion,
      entidad: f.entidad ?? null,
      id_entidad: f.id_entidad ?? null,
      detalle: f.detalle ?? null,
      ip: f.ip ?? null,
    }));
  }
}
