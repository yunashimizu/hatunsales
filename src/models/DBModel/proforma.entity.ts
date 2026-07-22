import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Cliente } from './cliente.entity';
import { Empresa } from './empresa.entity';
import { ProformaItem } from './proforma-item.entity';

@Entity('proformas')
export class Proforma {

  @PrimaryGeneratedColumn()
  id_proforma!: number;

  @ManyToOne(() => Empresa, { nullable: false })
  @JoinColumn({ name: 'id_empresa' })
  empresa!: Empresa;

  @ManyToOne(() => Cliente, { nullable: false })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ nullable: true })
  serie!: string;

  @Column({ type: 'integer' })
  numero!: number;

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
