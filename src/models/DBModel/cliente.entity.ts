import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Documento } from './documento.entity';
import { Usuarios } from './usuarios.entity';

@Entity('clientes')
export class Cliente {

  @PrimaryGeneratedColumn()
  id_cliente!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true, type: 'integer' })
  dni!: number;

  @Column({ nullable: true })
  telefono!: string;

  @Column({ nullable: true })
  email!: string;

  @Column({ nullable: true })
  direccion!: string;

  @Column({ nullable: true })
  apellido_paterno!: string;

  @Column({ nullable: true })
  apellido_materno!: string;

  @ManyToOne(() => Documento, { nullable: true })
  @JoinColumn({ name: 'id_documento' })
  documento!: Documento;

  @ManyToOne(() => Usuarios, { nullable: true })
  @JoinColumn({ name: 'id_usuario' })
  usuario!: Usuarios;

  @CreateDateColumn()
  creado_en!: Date;
}