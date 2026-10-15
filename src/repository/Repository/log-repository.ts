import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Auditoria } from '../../models/DBModel/auditoria.entity';
import type { RegistroLogResponse } from '../../models/model/log.response';
import { enmascararDatosPersonales } from '../../util/http/enmascarar';
import type { ILogRepository } from '../Irepository/ILogRepository';

/** Si la tabla falta, se vuelve a mirar el catálogo cada minuto (el dueño puede correr el script sin reiniciar). */
const REINTENTO_SI_FALTA_MS = 60_000;

const limitar = (texto: string, largo: number): string => String(texto ?? '').slice(0, largo);

function esTablaInexistente(error: unknown): boolean {
  const codigo = (error as { code?: unknown; driverError?: { code?: unknown } })?.driverError?.code
    ?? (error as { code?: unknown })?.code;
  return codigo === '42P01';
}

/**
 * Log de acciones del CRUD antiguo de usuarios, ahora en la tabla `auditoria`
 * de PostgreSQL (antes en un SQLite que Railway borraba en cada deploy).
 * Tolera que la tabla no exista: no registra y avisa una vez, sin DDL.
 */
@Injectable()
export class LogRepository implements ILogRepository {
  private readonly logger = new Logger(LogRepository.name);
  private estado: { readonly existe: boolean; readonly revisarDesde: number } | null = null;
  private revisionEnCurso: Promise<boolean> | null = null;

  constructor(
    @InjectRepository(Auditoria, 'pgConnection')
    private readonly auditoriaRepo: Repository<Auditoria>,
  ) {}

  async registrar(accion: string, entidad: string, idUsuario: number | null = null): Promise<void> {
    try {
      if (!(await this.tablaDisponible())) return;
      await this.auditoriaRepo.insert({
        accion: limitar(accion, 50),
        tabla: limitar(entidad, 100),
        usuario: Number.isInteger(idUsuario) ? idUsuario : null,
      });
    } catch (error) {
      if (esTablaInexistente(error)) this.marcar(false);
      const detalle = error instanceof Error ? error.message : String(error);
      this.logger.warn(`No se pudo registrar la auditoría (${accion} ${entidad}): ${enmascararDatosPersonales(detalle)}`);
    }
  }

  async ultimos(limite: number): Promise<RegistroLogResponse[]> {
    const filas = await this.auditoriaRepo.find({
      order: { fecha: { direction: 'DESC', nulls: 'LAST' }, id_auditoria: 'DESC' },
      take: limite,
    });
    return filas.map((fila) => ({
      idlog: fila.id_auditoria,
      accion: fila.accion ?? '',
      entidad: fila.tabla ?? '',
      fecha: fila.fecha ?? null,
    }));
  }

  async tablaDisponible(): Promise<boolean> {
    const ahora = Date.now();
    if (this.estado && (this.estado.existe || ahora < this.estado.revisarDesde)) return this.estado.existe;
    this.revisionEnCurso ??= this.revisarCatalogo().finally(() => {
      this.revisionEnCurso = null;
    });
    return this.revisionEnCurso;
  }

  private async revisarCatalogo(): Promise<boolean> {
    const filas: Array<{ existe?: boolean }> = await this.auditoriaRepo.query(
      `SELECT to_regclass('public.auditoria') IS NOT NULL AS existe`,
    );
    const existe = filas?.[0]?.existe === true;
    if (!existe && this.estado?.existe !== false) {
      this.logger.warn('La tabla auditoria no existe: falta ejecutar sql/fase10_indices_rendimiento.sql en Railway.');
    }
    this.marcar(existe);
    return existe;
  }

  private marcar(existe: boolean): void {
    this.estado = { existe, revisarDesde: Date.now() + REINTENTO_SI_FALTA_MS };
  }
}
