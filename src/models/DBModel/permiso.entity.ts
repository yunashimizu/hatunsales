import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('permisos')
export class Permiso {

  @PrimaryGeneratedColumn()
  id_permiso!: number;

  @Column()
  nombre!: string;
}