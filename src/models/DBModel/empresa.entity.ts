import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Usuarios } from './usuarios.entity';

@Entity('empresas')
export class Empresa {

  @PrimaryGeneratedColumn()
  id_empresa!: number;

  @Column({ unique: true })
  ruc!: string;

  @Column({ nullable: true })
  razon_social!: string;

  @Column({ nullable: true })
  nombre_comercial!: string;

  @Column({ nullable: true })
  telefonos!: string;

  /** Correo de la empresa (columna existente, VARCHAR(100)). Fase 3.4: «recordar este correo» desde el POS. */
  @Column({ nullable: true })
  email!: string;

  @Column({ nullable: true })
  tipo!: string;

  @Column({ nullable: true })
  estado!: string;

  @Column({ nullable: true })
  condicion!: string;

  @Column({ nullable: true })
  direccion!: string;

  @Column({ nullable: true })
  departamento!: string;

  @Column({ nullable: true })
  provincia!: string;

  @Column({ nullable: true })
  distrito!: string;

  @Column({ nullable: true })
  ubigeo!: string;

  @Column({ nullable: true })
  capital!: string;

  @Column({ nullable: true })
  fecha_inscripcion!: string;

  @Column({ nullable: true })
  fecha_baja!: string;

  @CreateDateColumn()
  creado_en!: Date;

  @ManyToOne(() => Usuarios, { nullable: true })
  @JoinColumn({ name: 'id_usuario' })
  usuario!: Usuarios;
}