import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { EjecutorSql, filasDe } from '../config/transacciones-fiscales';

export interface MetadatosCertificadoFiscal {
  id_certificado: number;
  ambiente: AmbienteFiscal;
  nombre_archivo: string | null;
  titular: string | null;
  ruc: string | null;
  numero_serie: string | null;
  emisor: string | null;
  vigente_desde: Date;
  vigente_hasta: Date;
  huella_sha256: string;
  bits_clave: number | null;
  autofirmado: boolean;
  certificado_pem: string | null;
  subido_por: number | null;
  subido_en: Date;
}

export interface FilaCertificadoFiscal extends MetadatosCertificadoFiscal {
  pfx_cifrado: Buffer;
  clave_cifrada: Buffer;
}

export interface VersionCertificadoFiscal {
  id_certificado: number;
  huella_sha256: string;
}

export interface NuevoCertificadoFiscal {
  ambiente: AmbienteFiscal;
  pfxCifrado: Buffer;
  claveCifrada: Buffer;
  nombreArchivo: string | null;
  titular: string | null;
  ruc: string | null;
  numeroSerie: string | null;
  emisor: string | null;
  vigenteDesde: Date;
  vigenteHasta: Date;
  huellaSha256: string;
  bitsClave: number;
  autofirmado: boolean;
  certificadoPem: string;
  subidoPor: number | null;
}

/** Puerto de persistencia de certificados (tabla fiscal_certificados). */
export abstract class RepositorioCertificadosFiscales {
  abstract activo(ambiente: AmbienteFiscal): Promise<FilaCertificadoFiscal | null>;
  /** Metadatos (sin secretos) de los certificados vigentes de ambos ambientes. */
  abstract metadatosActivos(): Promise<MetadatosCertificadoFiscal[]>;
  /** Consulta mínima para saber si la caché sigue al día. */
  abstract versionActiva(ambiente: AmbienteFiscal): Promise<VersionCertificadoFiscal | null>;
  /** Retira el vigente del ambiente (vaciando sus secretos) e inserta el nuevo. Requiere transacción. */
  abstract reemplazarActivo(
    nuevo: NuevoCertificadoFiscal,
    ejecutor: EjecutorSql,
  ): Promise<{ id_certificado: number; reemplazado: number | null }>;
  abstract retirarActivo(ambiente: AmbienteFiscal, idUsuario: number | null, ejecutor: EjecutorSql): Promise<number | null>;
  abstract actualizarCifrado(idCertificado: number, pfxCifrado: Buffer, claveCifrada: Buffer): Promise<void>;
}

const COLUMNAS_METADATOS = `id_certificado, ambiente, nombre_archivo, titular, ruc, numero_serie, emisor,
  vigente_desde, vigente_hasta, huella_sha256, bits_clave, autofirmado, certificado_pem, subido_por, subido_en`;

@Injectable()
export class CertificadoFiscalRepository extends RepositorioCertificadosFiscales {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async activo(ambiente: AmbienteFiscal): Promise<FilaCertificadoFiscal | null> {
    const filas = await this.dataSource.query(
      `SELECT ${COLUMNAS_METADATOS}, pfx_cifrado, clave_cifrada
         FROM fiscal_certificados
        WHERE ambiente = $1 AND activo AND eliminado_en IS NULL
        LIMIT 1`,
      [ambiente],
    );
    return filas[0] ? this.mapear(filas[0]) : null;
  }

  async metadatosActivos(): Promise<MetadatosCertificadoFiscal[]> {
    const filas = await this.dataSource.query(
      `SELECT ${COLUMNAS_METADATOS}
         FROM fiscal_certificados
        WHERE activo AND eliminado_en IS NULL
        ORDER BY ambiente`,
    );
    return filas.map((fila: any) => this.mapear(fila));
  }

  async versionActiva(ambiente: AmbienteFiscal): Promise<VersionCertificadoFiscal | null> {
    const filas = await this.dataSource.query(
      `SELECT id_certificado, huella_sha256
         FROM fiscal_certificados
        WHERE ambiente = $1 AND activo AND eliminado_en IS NULL
        LIMIT 1`,
      [ambiente],
    );
    return filas[0]
      ? { id_certificado: Number(filas[0].id_certificado), huella_sha256: String(filas[0].huella_sha256).trim() }
      : null;
  }

  async reemplazarActivo(
    nuevo: NuevoCertificadoFiscal,
    ejecutor: EjecutorSql,
  ): Promise<{ id_certificado: number; reemplazado: number | null }> {
    const reemplazado = await this.retirarActivo(nuevo.ambiente, nuevo.subidoPor, ejecutor);
    const filas = await ejecutor.query(
      `INSERT INTO fiscal_certificados (
         ambiente, activo, pfx_cifrado, clave_cifrada, version_clave, nombre_archivo, titular, ruc,
         numero_serie, emisor, vigente_desde, vigente_hasta, huella_sha256, bits_clave, autofirmado,
         certificado_pem, subido_por)
       VALUES ($1, TRUE, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id_certificado`,
      [
        nuevo.ambiente,
        nuevo.pfxCifrado,
        nuevo.claveCifrada,
        nuevo.nombreArchivo?.slice(0, 200) ?? null,
        nuevo.titular?.slice(0, 300) ?? null,
        nuevo.ruc,
        nuevo.numeroSerie?.slice(0, 80) ?? null,
        nuevo.emisor?.slice(0, 300) ?? null,
        nuevo.vigenteDesde,
        nuevo.vigenteHasta,
        nuevo.huellaSha256,
        nuevo.bitsClave,
        nuevo.autofirmado,
        nuevo.certificadoPem,
        nuevo.subidoPor,
      ],
    );
    return { id_certificado: Number(filasDe<any>(filas)[0].id_certificado), reemplazado };
  }

  async retirarActivo(ambiente: AmbienteFiscal, idUsuario: number | null, ejecutor: EjecutorSql): Promise<number | null> {
    // Serializa los cambios de certificado de un mismo ambiente entre instancias.
    await ejecutor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fiscal:certificado:${ambiente}`]);
    const retirados = filasDe<{ id_certificado: number }>(
      await ejecutor.query(
        `UPDATE fiscal_certificados
            SET activo = FALSE, eliminado_en = NOW(), eliminado_por = $2,
                pfx_cifrado = ''::bytea, clave_cifrada = ''::bytea
          WHERE ambiente = $1 AND activo AND eliminado_en IS NULL
         RETURNING id_certificado`,
        [ambiente, idUsuario],
      ),
    );
    return retirados[0] ? Number(retirados[0].id_certificado) : null;
  }

  async actualizarCifrado(idCertificado: number, pfxCifrado: Buffer, claveCifrada: Buffer): Promise<void> {
    await this.dataSource.query(
      `UPDATE fiscal_certificados
          SET pfx_cifrado = $2, clave_cifrada = $3
        WHERE id_certificado = $1 AND activo AND eliminado_en IS NULL`,
      [idCertificado, pfxCifrado, claveCifrada],
    );
  }

  private mapear(fila: any): FilaCertificadoFiscal {
    return {
      id_certificado: Number(fila.id_certificado),
      ambiente: fila.ambiente,
      nombre_archivo: fila.nombre_archivo ?? null,
      titular: fila.titular ?? null,
      ruc: fila.ruc ?? null,
      numero_serie: fila.numero_serie ?? null,
      emisor: fila.emisor ?? null,
      vigente_desde: new Date(fila.vigente_desde),
      vigente_hasta: new Date(fila.vigente_hasta),
      huella_sha256: String(fila.huella_sha256 ?? '').trim(),
      bits_clave: fila.bits_clave === null || fila.bits_clave === undefined ? null : Number(fila.bits_clave),
      autofirmado: !!fila.autofirmado,
      certificado_pem: fila.certificado_pem ?? null,
      subido_por: fila.subido_por === null || fila.subido_por === undefined ? null : Number(fila.subido_por),
      subido_en: new Date(fila.subido_en),
      pfx_cifrado: fila.pfx_cifrado,
      clave_cifrada: fila.clave_cifrada,
    };
  }
}
