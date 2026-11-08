import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { filasDe } from '../config/transacciones-fiscales';

export interface ContadoresAlertas {
  /** Envíos de comprobantes en EXCEPCION («Requiere revisión»). */
  excepcion: number;
  /** Lotes (bajas y resúmenes) sin respuesta de SUNAT tras 7 días: hay que «Liberar». */
  lotes_por_liberar: number;
  /** Envíos pendientes de SUNAT desde hace más de 2 horas. */
  pendientes_antiguos: number;
}

/** Contadores de la tarea de alertas por correo. Solo lee; el SQL se prueba con un consultor falso. */
@Injectable()
export class AlertasFiscalesRepository {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly bd: DataSource,
  ) {}

  async contadores(ambiente: AmbienteFiscal): Promise<ContadoresAlertas> {
    const filas = filasDe<Record<string, unknown>>(
      await this.bd.query(
        `SELECT
           (SELECT COUNT(*) FROM fiscal_envios t
             WHERE t.ambiente = $1 AND t.operacion = 'emitir' AND t.tipo_documento IN ('01', '03', '07', '08')
               AND t.id_comprobante IS NOT NULL AND t.estado = 'EXCEPCION')::int AS excepcion,
           (SELECT COUNT(*) FROM fiscal_envios t
             WHERE t.ambiente = $1 AND t.operacion IN ('resumen', 'baja') AND t.estado = 'EXCEPCION'
               AND t.respuesta_json #>> '{clasificacion,accion}' = 'LIBERAR')::int AS lotes_por_liberar,
           (SELECT COUNT(*) FROM fiscal_envios t
             WHERE t.ambiente = $1 AND t.operacion = 'emitir' AND t.tipo_documento IN ('01', '03', '07', '08')
               AND t.id_comprobante IS NOT NULL AND t.estado IN ('PENDIENTE_REENVIO', 'ENVIANDO')
               AND t.creado_en < NOW() - INTERVAL '2 hours')::int AS pendientes_antiguos`,
        [ambiente],
      ),
    );
    const fila = filas[0] ?? {};
    return {
      excepcion: Number(fila.excepcion ?? 0),
      lotes_por_liberar: Number(fila.lotes_por_liberar ?? 0),
      pendientes_antiguos: Number(fila.pendientes_antiguos ?? 0),
    };
  }
}
