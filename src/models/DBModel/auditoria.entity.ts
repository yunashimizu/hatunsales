import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Tabla `auditoria` de PostgreSQL (ya existe en producción; en entornos nuevos
 * la crea sql/fase10_indices_rendimiento.sql). Reemplaza al log antiguo en
 * SQLite, que se perdía en cada deploy de Railway.
 */
@Entity('auditoria')
export class Auditoria {
  @PrimaryGeneratedColumn({ name: 'id_auditoria' })
  id_auditoria!: number;

  /** Entidad afectada (p. ej. 'usuario'). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  tabla!: string | null;

  /** CREATE, UPDATE, DELETE… */
  @Column({ type: 'varchar', length: 50, nullable: true })
  accion!: string | null;

  /** id_usuario de quien hizo la acción, si se conoce. */
  @Column({ type: 'int', nullable: true })
  usuario!: number | null;

  @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  fecha!: Date | null;
}
