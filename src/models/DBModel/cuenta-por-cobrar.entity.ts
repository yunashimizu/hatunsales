import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cuentas_por_cobrar')
export class CuentaPorCobrar {

  @PrimaryGeneratedColumn()
  id_cxc!: number;

  @Column({ type: 'int' })
  id_venta!: number;

  @Column({ type: 'int', nullable: true })
  id_cliente!: number | null;

  @Column({ type: 'int', nullable: true })
  id_empresa!: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monto_total!: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  saldo!: number;

  @CreateDateColumn({ name: 'fecha_emision' })
  fecha_emision!: Date;

  @Column({ type: 'date' })
  fecha_vencimiento!: string;

  /** pendiente | parcial | pagado | vencido | anulado */
  @Column({ default: 'pendiente' })
  estado!: string;

  @CreateDateColumn({ name: 'creado_en' })
  creado_en!: Date;
}
