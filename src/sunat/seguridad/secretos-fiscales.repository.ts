import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EjecutorSql, filasDe } from '../config/transacciones-fiscales';

export interface SecretoFiscalGuardado {
  valor_cifrado: Buffer;
  actualizado_en: Date;
  actualizado_por: number | null;
}

/** Puerto de persistencia de secretos cifrados (tabla fiscal_secretos). */
export abstract class RepositorioSecretosFiscales {
  abstract leer(clave: string): Promise<SecretoFiscalGuardado | null>;
  /** Solo metadatos: no trae el valor cifrado. */
  abstract metadatos(clave: string): Promise<Omit<SecretoFiscalGuardado, 'valor_cifrado'> | null>;
  abstract guardar(clave: string, valorCifrado: Buffer, idUsuario: number | null, ejecutor?: EjecutorSql): Promise<void>;
  /** true si existía. */
  abstract eliminar(clave: string, ejecutor?: EjecutorSql): Promise<boolean>;
}

@Injectable()
export class SecretosFiscalesRepository extends RepositorioSecretosFiscales {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async leer(clave: string): Promise<SecretoFiscalGuardado | null> {
    const filas = await this.dataSource.query(
      'SELECT valor_cifrado, actualizado_en, actualizado_por FROM fiscal_secretos WHERE clave = $1',
      [clave],
    );
    if (!filas[0]) return null;
    return {
      valor_cifrado: filas[0].valor_cifrado,
      actualizado_en: new Date(filas[0].actualizado_en),
      actualizado_por: filas[0].actualizado_por === null ? null : Number(filas[0].actualizado_por),
    };
  }

  async metadatos(clave: string): Promise<Omit<SecretoFiscalGuardado, 'valor_cifrado'> | null> {
    const filas = await this.dataSource.query(
      `SELECT actualizado_en, actualizado_por
         FROM fiscal_secretos
        WHERE clave = $1 AND octet_length(valor_cifrado) > 0`,
      [clave],
    );
    if (!filas[0]) return null;
    return {
      actualizado_en: new Date(filas[0].actualizado_en),
      actualizado_por: filas[0].actualizado_por === null ? null : Number(filas[0].actualizado_por),
    };
  }

  async guardar(clave: string, valorCifrado: Buffer, idUsuario: number | null, ejecutor?: EjecutorSql): Promise<void> {
    await (ejecutor ?? this.dataSource).query(
      `INSERT INTO fiscal_secretos (clave, valor_cifrado, version_clave, actualizado_por, actualizado_en)
       VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (clave) DO UPDATE
          SET valor_cifrado = EXCLUDED.valor_cifrado,
              version_clave = EXCLUDED.version_clave,
              actualizado_por = EXCLUDED.actualizado_por,
              actualizado_en = NOW()`,
      [clave, valorCifrado, idUsuario],
    );
  }

  async eliminar(clave: string, ejecutor?: EjecutorSql): Promise<boolean> {
    const borradas = filasDe<{ clave: string }>(
      await (ejecutor ?? this.dataSource).query('DELETE FROM fiscal_secretos WHERE clave = $1 RETURNING clave', [clave]),
    );
    return borradas.length > 0;
  }
}
