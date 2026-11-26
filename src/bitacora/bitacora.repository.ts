import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ZONA_LIMA } from '../util/fecha-lima';

/** Fila ya lista para insertar (textos recortados, JSON serializado). */
export interface FilaBitacoraNueva {
  id_usuario: number | null;
  rol: string | null;
  id_autorizador: number | null;
  id_almacen: number | null;
  accion: string;
  entidad: string | null;
  id_entidad: number | null;
  antes: string | null;
  despues: string | null;
  motivo: string | null;
  ip: string | null;
}

/** Filtro ya validado de la pantalla «Actividad». `desde`/`hasta` son días de Lima 'YYYY-MM-DD'. */
export interface FiltroBitacora {
  desde?: string;
  hasta?: string;
  id_usuario?: number;
  accion?: string;
  entidad?: string;
  id_entidad?: number;
  /** Paginación por cursor: registros con id menor a este. */
  antes_de?: number;
  limite: number;
}

export interface RegistroBitacora {
  id: number;
  /** Instante ISO (UTC). */
  fecha: string;
  id_usuario: number | null;
  /** Nombre del usuario (vacío si ya no existe). */
  usuario: string;
  rol: string | null;
  id_autorizador: number | null;
  autorizador: string | null;
  id_almacen: number | null;
  almacen: string | null;
  accion: string;
  entidad: string | null;
  id_entidad: number | null;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
  motivo: string | null;
  ip: string | null;
}

const COLUMNAS = [
  'id_usuario', 'rol', 'id_autorizador', 'id_almacen', 'accion', 'entidad', 'id_entidad', 'antes', 'despues', 'motivo', 'ip',
] as const;
const TIPOS: Record<(typeof COLUMNAS)[number], string> = {
  id_usuario: 'int', rol: 'text', id_autorizador: 'int', id_almacen: 'int', accion: 'text', entidad: 'text',
  id_entidad: 'bigint', antes: 'jsonb', despues: 'jsonb', motivo: 'text', ip: 'text',
};

/** Inicio de un día de Lima como timestamptz (la columna `fecha` es TIMESTAMPTZ). */
function inicioDiaLimaTz(parametro: string): string {
  return `(CAST(${parametro} AS date)::timestamp AT TIME ZONE '${ZONA_LIMA}')`;
}

/**
 * Acceso a `bitacora_acciones` (sql/fase19). Sin llaves foráneas hacia usuarios: la bitácora sobrevive
 * al borrado de un usuario; el nombre se busca al leer. Quien llama comprueba antes la capacidad
 * `bitacora` (BitacoraService): este repositorio no mira el esquema.
 */
@Injectable()
export class BitacoraRepository {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /** Un solo INSERT para todas las filas. */
  async insertar(filas: FilaBitacoraNueva[]): Promise<void> {
    if (!filas.length) return;
    const arreglos = COLUMNAS.map((c, i) => `$${i + 1}::${TIPOS[c] === 'jsonb' ? 'text' : TIPOS[c]}[]`);
    const select = COLUMNAS.map((c) => (TIPOS[c] === 'jsonb' ? `b.${c}::jsonb` : `b.${c}`));
    await this.dataSource.query(
      `INSERT INTO bitacora_acciones (${COLUMNAS.join(', ')})
       SELECT ${select.join(', ')}
         FROM unnest(${arreglos.join(', ')}) WITH ORDINALITY AS b(${COLUMNAS.join(', ')}, n)
        ORDER BY b.n`,
      COLUMNAS.map((c) => filas.map((f) => f[c])),
    );
  }

  /** Lo más reciente primero; `antes_de` pagina por id (keyset, sin OFFSET). */
  async listar(filtro: FiltroBitacora): Promise<RegistroBitacora[]> {
    const condiciones: string[] = [];
    const parametros: unknown[] = [];
    const agregar = (valor: unknown, condicion: (p: string) => string) => {
      parametros.push(valor);
      condiciones.push(condicion(`$${parametros.length}`));
    };
    if (filtro.desde) agregar(filtro.desde, (p) => `b.fecha >= ${inicioDiaLimaTz(p)}`);
    if (filtro.hasta) agregar(filtro.hasta, (p) => `b.fecha < (${inicioDiaLimaTz(p)} + INTERVAL '1 day')`);
    if (filtro.id_usuario) agregar(filtro.id_usuario, (p) => `b.id_usuario = ${p}::int`);
    if (filtro.accion) agregar(filtro.accion, (p) => `b.accion = ${p}`);
    if (filtro.entidad) agregar(filtro.entidad, (p) => `b.entidad = ${p}`);
    if (filtro.id_entidad) agregar(filtro.id_entidad, (p) => `b.id_entidad = ${p}::bigint`);
    if (filtro.antes_de) agregar(filtro.antes_de, (p) => `b.id < ${p}::bigint`);
    parametros.push(filtro.limite);
    const limite = `$${parametros.length}`;

    const filas: any[] = await this.dataSource.query(
      `SELECT b.id, b.fecha, b.id_usuario, b.rol, b.id_autorizador, b.id_almacen, b.accion, b.entidad, b.id_entidad,
              b.antes, b.despues, b.motivo, b.ip,
              NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido_paterno)), '') AS usuario,
              NULLIF(TRIM(CONCAT_WS(' ', au.nombre, au.apellido_paterno)), '') AS autorizador,
              al.nombre AS almacen
         FROM bitacora_acciones b
         LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario
         LEFT JOIN usuarios au ON au.id_usuario = b.id_autorizador
         LEFT JOIN almacenes al ON al.id_almacen = b.id_almacen
        ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}
        ORDER BY b.id DESC
        LIMIT ${limite}`,
      parametros,
    );

    const entero = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return filas.map((f) => ({
      id: Number(f.id),
      fecha: f.fecha instanceof Date ? f.fecha.toISOString() : String(f.fecha),
      id_usuario: entero(f.id_usuario),
      usuario: f.usuario ? String(f.usuario) : '',
      rol: f.rol ?? null,
      id_autorizador: entero(f.id_autorizador),
      autorizador: f.autorizador ? String(f.autorizador) : null,
      id_almacen: entero(f.id_almacen),
      almacen: f.almacen ? String(f.almacen) : null,
      accion: String(f.accion),
      entidad: f.entidad ?? null,
      id_entidad: entero(f.id_entidad),
      antes: f.antes ?? null,
      despues: f.despues ?? null,
      motivo: f.motivo ?? null,
      ip: f.ip ?? null,
    }));
  }
}
