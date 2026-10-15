import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheTtl } from './cache-ttl';
import { ErroresFiscales } from './fiscal-errores';
import { RelojFiscal } from './reloj-fiscal';

/**
 * Verificación del esquema de la fase 9 SIN DDL: solo lee el catálogo.
 *
 * Al arrancar informa en el log qué falta. Mientras falte algo, SUNAT directo
 * queda en «migración pendiente» (los endpoints responden 503 con un mensaje
 * claro) y Nubefact sigue igual. Si el dueño ejecuta el script con la API
 * encendida, se detecta solo en ≤ 30 s, sin reiniciar.
 */

export type GrupoEsquemaFiscal = 'secretos' | 'auditoria' | 'emision' | 'catalogo';

interface RequisitoEsquema {
  grupo: GrupoEsquemaFiscal;
  tabla: string;
  /** Vacío = basta con que exista la tabla. */
  columna: string;
}

const tabla = (grupo: GrupoEsquemaFiscal, nombre: string): RequisitoEsquema => ({ grupo, tabla: nombre, columna: '' });
const columnas = (grupo: GrupoEsquemaFiscal, nombre: string, lista: string[]): RequisitoEsquema[] =>
  lista.map((columna) => ({ grupo, tabla: nombre, columna }));

export const REQUISITOS_ESQUEMA_FISCAL: readonly RequisitoEsquema[] = [
  tabla('secretos', 'fiscal_certificados'),
  ...columnas('secretos', 'fiscal_certificados', ['certificado_pem']),
  tabla('secretos', 'fiscal_secretos'),
  tabla('auditoria', 'fiscal_auditoria'),
  tabla('emision', 'fiscal_resumen_lineas'),
  ...columnas('emision', 'comprobantes', [
    'proveedor_fiscal', 'ambiente_fiscal', 'estado_sunat', 'emitido_en', 'fecha_limite_envio',
    'sunat_observaciones', 'forma_pago', 'cuotas', 'doc_modificado_tipo', 'doc_modificado_serie',
    'doc_modificado_numero', 'id_comprobante_modificado', 'nota_motivo', 'nota_sustento', 'id_envio_ultimo',
  ]),
  ...columnas('emision', 'productos', ['codigo_sunat']),
  ...columnas('emision', 'fiscal_envios', [
    'identificador', 'fecha_referencia', 'proximo_intento_en', 'bloqueado_hasta', 'hash_xml', 'tiempo_ms', 'id_usuario',
  ]),
  ...columnas('emision', 'fiscal_artifacts', ['contenido', 'nombre', 'id_comprobante']),
];

/** Filas de catálogo que la fase 9 inserta (sin ellas la FK impide guardar notas). */
const TIPOS_REQUERIDOS: ReadonlyArray<{ id: number; nombre: string }> = [
  { id: 7, nombre: 'NOTA DE CREDITO' },
  { id: 8, nombre: 'NOTA DE DEBITO' },
];

export interface EstadoEsquemaFiscal {
  /** false si la verificación misma falló (BD caída): no se sabe. */
  verificado: boolean;
  listo: boolean;
  grupos: Record<GrupoEsquemaFiscal, boolean>;
  faltantes: string[];
  mensaje: string | null;
  verificado_en: string | null;
  error?: string;
}

@Injectable()
export class FiscalEsquemaService implements OnApplicationBootstrap {
  static readonly SCRIPT = 'sql/fase9_sunat_directo.sql';
  private static readonly TTL_LISTO_MS = 10 * 60_000;
  private static readonly TTL_PENDIENTE_MS = 30_000;
  private static readonly TTL_ERROR_MS = 5_000;

  private readonly logger = new Logger(FiscalEsquemaService.name);
  private readonly cache: CacheTtl<EstadoEsquemaFiscal>;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly reloj: RelojFiscal,
  ) {
    this.cache = new CacheTtl<EstadoEsquemaFiscal>(
      (estado) =>
        !estado.verificado
          ? FiscalEsquemaService.TTL_ERROR_MS
          : estado.listo
            ? FiscalEsquemaService.TTL_LISTO_MS
            : FiscalEsquemaService.TTL_PENDIENTE_MS,
      () => this.reloj.ms(),
    );
  }

  /** No retrasa el arranque: la verificación corre en segundo plano y solo informa. */
  onApplicationBootstrap(): void {
    void this.estado()
      .then((estado) => this.informar(estado))
      .catch((error) => this.logger.warn(`No se pudo verificar el esquema fiscal: ${error?.message ?? error}`));
  }

  estado(): Promise<EstadoEsquemaFiscal> {
    return this.cache.obtener('esquema', () => this.verificar());
  }

  async tiene(...grupos: GrupoEsquemaFiscal[]): Promise<boolean> {
    const estado = await this.estado();
    return grupos.every((grupo) => estado.grupos[grupo]);
  }

  /** 503 FISCAL_MIGRACION_PENDIENTE si falta algo de los grupos pedidos. */
  async exigir(...grupos: GrupoEsquemaFiscal[]): Promise<void> {
    const estado = await this.estado();
    if (grupos.every((grupo) => estado.grupos[grupo])) return;
    throw ErroresFiscales.migracionPendiente(estado.faltantes);
  }

  /** Vuelve a leer el catálogo (p. ej. después de que el dueño corrió el script). */
  refrescar(): Promise<EstadoEsquemaFiscal> {
    this.cache.invalidar();
    return this.estado();
  }

  private async verificar(): Promise<EstadoEsquemaFiscal> {
    const grupos: Record<GrupoEsquemaFiscal, boolean> = { secretos: true, auditoria: true, emision: true, catalogo: true };
    try {
      const filas: Array<{ grupo: GrupoEsquemaFiscal; tabla: string; columna: string; existe: boolean }> =
        await this.dataSource.query(
          `SELECT r.grupo, r.tabla, r.columna,
                  CASE WHEN r.columna = '' THEN EXISTS (
                         SELECT 1 FROM pg_catalog.pg_class t
                           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                          WHERE n.nspname = current_schema() AND t.relname = r.tabla AND t.relkind IN ('r', 'p'))
                       ELSE EXISTS (
                         SELECT 1 FROM pg_catalog.pg_attribute a
                           JOIN pg_catalog.pg_class t ON t.oid = a.attrelid
                           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                          WHERE n.nspname = current_schema() AND t.relname = r.tabla
                            AND a.attname = r.columna AND a.attnum > 0 AND NOT a.attisdropped)
                  END AS existe
             FROM unnest($1::text[], $2::text[], $3::text[]) AS r(grupo, tabla, columna)`,
          [
            REQUISITOS_ESQUEMA_FISCAL.map((r) => r.grupo),
            REQUISITOS_ESQUEMA_FISCAL.map((r) => r.tabla),
            REQUISITOS_ESQUEMA_FISCAL.map((r) => r.columna),
          ],
        );

      const faltantes: string[] = [];
      for (const fila of filas) {
        if (fila.existe) continue;
        grupos[fila.grupo] = false;
        faltantes.push(fila.columna ? `columna ${fila.tabla}.${fila.columna}` : `tabla ${fila.tabla}`);
      }

      const tipos: Array<{ id_tipo: number }> = await this.dataSource.query(
        'SELECT id_tipo FROM tipos_comprobante WHERE id_tipo = ANY($1::int[])',
        [TIPOS_REQUERIDOS.map((t) => t.id)],
      );
      const presentes = new Set(tipos.map((t) => Number(t.id_tipo)));
      for (const tipo of TIPOS_REQUERIDOS) {
        if (presentes.has(tipo.id)) continue;
        grupos.catalogo = false;
        faltantes.push(`tipos_comprobante ${tipo.id} (${tipo.nombre})`);
      }

      const listo = faltantes.length === 0;
      return {
        verificado: true,
        listo,
        grupos,
        faltantes,
        mensaje: listo ? null : `Falta ejecutar ${FiscalEsquemaService.SCRIPT} en la base de datos.`,
        verificado_en: this.reloj.ahora().toISOString(),
      };
    } catch (error: any) {
      // Sin poder leer el catálogo no se habilita nada de SUNAT directo.
      return {
        verificado: false,
        listo: false,
        grupos: { secretos: false, auditoria: false, emision: false, catalogo: false },
        faltantes: [],
        mensaje: 'No se pudo verificar el esquema fiscal en la base de datos; se reintentará en unos segundos.',
        verificado_en: this.reloj.ahora().toISOString(),
        error: String(error?.message ?? error).slice(0, 300),
      };
    }
  }

  private informar(estado: EstadoEsquemaFiscal): void {
    if (estado.listo) {
      this.logger.log('Esquema fiscal (fase 9) verificado: SUNAT directo disponible para configurar.');
    } else if (!estado.verificado) {
      this.logger.warn(`${estado.mensaje} Detalle: ${estado.error}`);
    } else {
      this.logger.warn(
        `SUNAT directo en «migración pendiente»: ${estado.mensaje} Faltan: ${estado.faltantes.join(', ')}. `
          + 'Nubefact sigue operando con normalidad.',
      );
    }
  }
}
