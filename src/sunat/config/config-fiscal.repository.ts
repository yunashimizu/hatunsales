import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { EjecutorSql, filasDe, TransaccionesFiscales } from './transacciones-fiscales';

/** Puerto de persistencia de la configuración fiscal (tabla `configuraciones`). */
export abstract class RepositorioConfigFiscal {
  /**
   * Valores de varias claves en una consulta; las ausentes o vacías vienen como null. Con ejecutor se
   * lee dentro de esa transacción (con la misma conexión: nunca pide otra al pool).
   */
  abstract leer(claves: readonly string[], ejecutor?: EjecutorSql): Promise<Record<string, string | null>>;
  /** Guarda varias claves de forma atómica. Con ejecutor, dentro de esa transacción. */
  abstract guardar(pares: Readonly<Record<string, string>>, ejecutor?: EjecutorSql): Promise<void>;
}

/**
 * Implementación SQL. `configuraciones` no tiene índice único en `clave` en
 * producción (fase 8 pendiente), así que el upsert es UPDATE + INSERT de las que
 * falten, protegido con los MISMOS candados consultivos que usa
 * ConfiguracionRepository.guardar ('configuraciones:<clave>'), tomados en orden
 * alfabético para que dos guardados simultáneos no se bloqueen en cruz.
 */
@Injectable()
export class ConfigFiscalRepository extends RepositorioConfigFiscal {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly transacciones: TransaccionesFiscales,
    configuracionGeneral: ConfiguracionRepository,
    notificador: NotificadorCambiosFiscales,
  ) {
    super();
    // La caché general (60 s) también sirve emisor_* a /configuracion/fiscal y a la venta.
    notificador.suscribir((tipo) => {
      if (tipo === 'config') configuracionGeneral.limpiarCache();
    });
  }

  async leer(claves: readonly string[], ejecutor?: EjecutorSql): Promise<Record<string, string | null>> {
    const resultado: Record<string, string | null> = Object.fromEntries(claves.map((c) => [c, null]));
    if (!claves.length) return resultado;

    // Si hubiera claves repetidas, gana la fila más reciente (mayor id_config).
    const filas = filasDe<{ clave: string; valor: string | null }>(
      await (ejecutor ?? this.dataSource).query(
        'SELECT clave, valor FROM configuraciones WHERE clave = ANY($1::text[]) ORDER BY id_config',
        [claves],
      ),
    );
    for (const fila of filas) {
      resultado[fila.clave] = fila.valor === null || fila.valor === '' ? null : String(fila.valor);
    }
    return resultado;
  }

  async guardar(pares: Readonly<Record<string, string>>, ejecutor?: EjecutorSql): Promise<void> {
    const claves = Object.keys(pares).sort();
    if (!claves.length) return;
    if (!ejecutor) {
      await this.transacciones.ejecutar((tx) => this.guardar(pares, tx));
      return;
    }

    const valores = claves.map((clave) => String(pares[clave] ?? ''));
    await ejecutor.query(
      `SELECT pg_advisory_xact_lock(hashtext('configuraciones:' || c.clave))
         FROM unnest($1::text[]) WITH ORDINALITY AS c(clave, orden)
        ORDER BY c.orden`,
      [claves],
    );
    await ejecutor.query(
      `UPDATE configuraciones AS c
          SET valor = d.valor
         FROM unnest($1::text[], $2::text[]) AS d(clave, valor)
        WHERE c.clave = d.clave`,
      [claves, valores],
    );
    await ejecutor.query(
      `INSERT INTO configuraciones (clave, valor)
       SELECT d.clave, d.valor
         FROM unnest($1::text[], $2::text[]) AS d(clave, valor)
        WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = d.clave)`,
      [claves, valores],
    );
  }
}
