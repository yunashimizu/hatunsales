import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Cliente } from './cliente.entity';
import { Empresa } from './empresa.entity';
import { GuiaRemisionItem } from './guia-remision-item.entity';

@Entity('guias_remision')
export class GuiaRemision {

  @PrimaryGeneratedColumn()
  id_guia!: number;

  @ManyToOne(() => Empresa, { nullable: false })
  @JoinColumn({ name: 'id_empresa' })
  empresa!: Empresa;

  @ManyToOne(() => Cliente, { nullable: false })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ nullable: true })
  direccion_origen!: string;

  @Column({ nullable: true })
  direccion_destino!: string;

  @Column({ nullable: true })
  motivo_traslado!: string;

  @Column({ nullable: true })
  peso_total!: string;

  @OneToMany(() => GuiaRemisionItem, (item) => item.guia, { cascade: true })
  items!: GuiaRemisionItem[];

  @CreateDateColumn()
  creado_en!: Date;
}
