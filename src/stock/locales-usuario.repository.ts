import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { filasDe } from '../caja/bd/resultado-consulta';

export interface LocalAsignado {
  id_sucursal: number;
  nombre: string;
}

export interface AsignacionLocal extends LocalAsignado {
  id_usuario: number;
}

export interface UsuarioParaLocales {
  id_usuario: number;
  nombre: string;
  rol: string;
}

/**
 * Fase 8.5 (D7): `usuario_sucursal (id_usuario, id_sucursal)`, que ya existe en producción y está vacía (R9).
 * Sin filas para un usuario = sin restricción (el comportamiento de hoy).
 */
@Injectable()
export class LocalesUsuarioRepository {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Almacenes de los locales del usuario. null = el usuario no tiene ningún local asignado (sin restricción).
   * Un local sin almacenes deja al usuario sin almacenes (lista vacía), no sin restricción.
   */
  async almacenesPermitidos(idUsuario: number): Promise<number[] | null> {
    const filas = filasDe<{ id_sucursal: unknown; id_almacen: unknown }>(await this.dataSource.query(
      `SELECT us.id_sucursal, a.id_almacen
         FROM usuario_sucursal us
         LEFT JOIN almacenes a ON a.id_sucursal = us.id_sucursal
        WHERE us.id_usuario = $1`,
      [idUsuario],
    ));
    if (!filas.length) return null;
    return [...new Set(filas.filter((f) => f.id_almacen !== null && f.id_almacen !== undefined).map((f) => Number(f.id_almacen)))];
  }

  async localesDe(idUsuario: number): Promise<LocalAsignado[]> {
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT us.id_sucursal, COALESCE(s.nombre, '') AS nombre
         FROM usuario_sucursal us
         LEFT JOIN sucursales s ON s.id_sucursal = us.id_sucursal
        WHERE us.id_usuario = $1
        ORDER BY s.nombre, us.id_sucursal`,
      [idUsuario],
    ));
    return filas.map((f) => ({ id_sucursal: Number(f.id_sucursal), nombre: String(f.nombre ?? '') }));
  }

  async todas(): Promise<AsignacionLocal[]> {
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT us.id_usuario, us.id_sucursal, COALESCE(s.nombre, '') AS nombre
         FROM usuario_sucursal us
         LEFT JOIN sucursales s ON s.id_sucursal = us.id_sucursal
        ORDER BY us.id_usuario, s.nombre, us.id_sucursal`,
    ));
    return filas.map((f) => ({ id_usuario: Number(f.id_usuario), id_sucursal: Number(f.id_sucursal), nombre: String(f.nombre ?? '') }));
  }

  async usuario(idUsuario: number): Promise<UsuarioParaLocales | null> {
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT u.id_usuario, COALESCE(u.nombre, '') AS nombre, COALESCE(r.nombre, '') AS rol
         FROM usuarios u
         LEFT JOIN roles r ON r.id_rol = u.id_rol
        WHERE u.id_usuario = $1`,
      [idUsuario],
    ));
    const f = filas[0];
    return f ? { id_usuario: Number(f.id_usuario), nombre: String(f.nombre), rol: String(f.rol) } : null;
  }

  async sucursalesExistentes(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const filas = filasDe<{ id_sucursal: unknown }>(await this.dataSource.query(
      'SELECT id_sucursal FROM sucursales WHERE id_sucursal = ANY($1::int[])',
      [ids],
    ));
    return new Set(filas.map((f) => Number(f.id_sucursal)));
  }

  /** Almacén con su local, para el mensaje del 403. */
  async almacen(idAlmacen: number): Promise<{ nombre: string; sucursal: string } | null> {
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT COALESCE(a.nombre, '') AS nombre, COALESCE(s.nombre, '') AS sucursal
         FROM almacenes a LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
        WHERE a.id_almacen = $1`,
      [idAlmacen],
    ));
    return filas[0] ? { nombre: String(filas[0].nombre), sucursal: String(filas[0].sucursal) } : null;
  }

  /**
   * Reemplaza los locales del usuario en una transacción (todo o nada). Lista vacía = sin restricción.
   * Devuelve los que tenía antes (para la bitácora). El candado de transacción por usuario ordena dos
   * cambios simultáneos del mismo usuario.
   */
  async reemplazar(idUsuario: number, idsSucursal: number[]): Promise<number[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`usuario-locales:${idUsuario}`]);
      const antes = filasDe<{ id_sucursal: unknown }>(await manager.query(
        'SELECT id_sucursal FROM usuario_sucursal WHERE id_usuario = $1 ORDER BY id_sucursal',
        [idUsuario],
      )).map((f) => Number(f.id_sucursal));
      await manager.query('DELETE FROM usuario_sucursal WHERE id_usuario = $1', [idUsuario]);
      if (idsSucursal.length) {
        await manager.query(
          `INSERT INTO usuario_sucursal (id_usuario, id_sucursal)
           SELECT $1, s FROM unnest($2::int[]) AS s`,
          [idUsuario, idsSucursal],
        );
      }
      return antes;
    });
  }
}
