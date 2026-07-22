import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Usuarios } from './usuarios.entity';

@Entity('roles')
export class Rol {

  @PrimaryGeneratedColumn()
  id_rol!: number;

  @Column()
  nombre!: string;

  @OneToMany(() => Usuarios, (u) => u.rol)
  usuarios!: Usuarios[];
}