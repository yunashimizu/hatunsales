import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Rol } from './role.entity';

@Entity('usuarios')
export class Usuarios {

  @PrimaryGeneratedColumn()
  id_usuario!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  apellido_paterno!: string;

  @Column({ nullable: true })
  apellido_materno!: string;

  @Column({ unique: true, nullable: true })
  dni!: string;

  @Column({ unique: true, nullable: true })
  email!: string;

  @Column({ nullable: true })
  password!: string;

  @Column({ default: true })
  estado!: boolean;

  @ManyToOne(() => Rol, (r) => r.usuarios)
  @JoinColumn({ name: 'id_rol' })
  rol!: Rol;
}