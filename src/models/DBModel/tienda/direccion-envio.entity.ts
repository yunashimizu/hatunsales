import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Cliente } from '../cliente.entity';

@Entity('direcciones_envio')
export class DireccionEnvio {

  @PrimaryGeneratedColumn()
  id_direccion!: number;

  @ManyToOne(() => Cliente, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ nullable: true })
  alias!: string;

  @Column({ nullable: true })
  destinatario!: string;

  @Column({ nullable: true })
  telefono!: string;

  @Column({ nullable: true })
  departamento!: string;

  @Column({ nullable: true })
  provincia!: string;

  @Column({ nullable: true })
  distrito!: string;

  @Column()
  direccion!: string;

  @Column({ nullable: true })
  referencia!: string;

  @Column({ nullable: true })
  codigo_postal!: string;

  @Column({ nullable: true, default: false })
  es_predeterminada!: boolean;

  @CreateDateColumn()
  creado_en!: Date;
}
