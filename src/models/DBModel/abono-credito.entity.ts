import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('abonos_credito')
export class AbonoCredito {

  @PrimaryGeneratedColumn()
  id_abono!: number;

  @Column({ type: 'int' })
  id_cxc!: number;

  @Column({ type: 'int', nullable: true })
  id_metodo!: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto!: number;

  @Column({ nullable: true })
  referencia!: string | null;

  @Column({ type: 'int', nullable: true })
  id_usuario!: number | null;

  @CreateDateColumn({ name: 'creado_en' })
  creado_en!: Date;
}
