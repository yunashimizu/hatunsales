import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('usuario')
export class Usuario {

  @PrimaryGeneratedColumn()
  idusuario!: number;

  @Column()
  nombre!: string;

  @Column()
  contrasena!: string;
}