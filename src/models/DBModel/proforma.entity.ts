import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Cliente } from './cliente.entity';
import { Empresa } from './empresa.entity';
import { ProformaItem } from './proforma-item.entity';

@Entity('proformas')
export class Proforma {

  @PrimaryGeneratedColumn()
  id_proforma!: number;

  @ManyToOne(() => Empresa, { nullable: true })
  @JoinColumn({ name: 'id_empresa' })
  empresa!: Empresa | null;

  @ManyToOne(() => Cliente, { nullable: true })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente | null;

  @Column({ nullable: true })
  serie!: string;

  @Column({ type: 'integer', nullable: true })
  numero!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  codigo!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'borrador' })
  estado!: string;

  @Column({ type: 'text', nullable: true })
  observaciones!: string | null;

  @Column({ type: 'date', nullable: true })
  valida_hasta!: string | null;

  @Column({ type: 'integer', nullable: true })
  id_almacen!: number | null;

  @Column({ type: 'varchar', length: 250, nullable: true })
  cliente_nombre_snapshot!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  telefono_envio!: string | null;

  @Column({ type: 'integer', nullable: true })
  id_venta!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  enviada_wa_en!: Date | null;

  @Column({ type: 'numeric', default: 0 })
  total_gravada!: number;

  @Column({ type: 'numeric', default: 0 })
  total_igv!: number;

  @Column({ type: 'numeric', default: 0 })
  total!: number;

  @OneToMany(() => ProformaItem, (item) => item.proforma, { cascade: true })
  items!: ProformaItem[];

  @CreateDateColumn()
  creado_en!: Date;
}
