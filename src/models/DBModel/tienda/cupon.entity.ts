import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cupones')
export class Cupon {

  @PrimaryGeneratedColumn()
  id_cupon!: number;

  @Column({ unique: true })
  codigo!: string;

  @Column({ nullable: true })
  descripcion!: string;

  /** porcentaje | monto */
  @Column({ default: 'porcentaje' })
  tipo!: string;

  @Column({ type: 'numeric', default: 0 })
  valor!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  minimo_compra!: number;

  @Column({ nullable: true, type: 'integer' })
  usos_maximos!: number;

  @Column({ nullable: true, type: 'integer', default: 0 })
  usos_actuales!: number;

  @Column({ nullable: true, type: 'date' })
  fecha_inicio!: Date;

  @Column({ nullable: true, type: 'date' })
  fecha_fin!: Date;

  @Column({ nullable: true, default: true })
  activo!: boolean;

  @CreateDateColumn()
  creado_en!: Date;
}
