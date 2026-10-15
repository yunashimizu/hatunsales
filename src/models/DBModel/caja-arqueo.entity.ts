import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CajaArqueoDenominacion } from './caja-arqueo-denominacion.entity';

/**
 * Arqueo de caja (sql/fase11_caja_arqueo_ventas.sql). Los montos NUMERIC se leen como texto
 * para no perder exactitud; la API los convierte a céntimos (src/caja/dominio/dinero.ts).
 * Las escrituras van por SQL dentro de la transacción del arqueo (CajaArqueoRepository).
 */
@Entity('caja_arqueos')
export class CajaArqueo {
  @PrimaryGeneratedColumn()
  id_arqueo!: number;

  @Column({ type: 'int' })
  id_apertura!: number;

  @Column({ type: 'int', nullable: true })
  id_caja!: number | null;

  @Column({ type: 'int', nullable: true })
  id_usuario!: number | null;

  /** 'parcial' | 'cierre' */
  @Column({ type: 'varchar', length: 10 })
  tipo!: 'parcial' | 'cierre';

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto_inicial!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  efectivo_esperado!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  efectivo_contado!: string;

  /** efectivo_contado − efectivo_esperado (negativo = faltante). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  diferencia!: string;

  /** { efectivo: {...}, "<id_metodo>": {...}, credito?: {...}, resumen: {...} } */
  @Column({ type: 'jsonb' })
  resumen_metodos!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  observacion!: string | null;

  @Column({ type: 'boolean', default: true })
  conteo_por_denominaciones!: boolean;

  @Column({ type: 'varchar', length: 80, nullable: true })
  clave_idempotencia!: string | null;

  /** Cierre del turno que tomó este arqueo (solo tipo 'cierre'). */
  @Column({ type: 'int', nullable: true })
  id_cierre!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'creado_en' })
  creado_en!: Date;

  @OneToMany(() => CajaArqueoDenominacion, (d) => d.arqueo)
  denominaciones?: CajaArqueoDenominacion[];
}
