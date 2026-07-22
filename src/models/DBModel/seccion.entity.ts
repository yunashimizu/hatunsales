import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('secciones')
export class Seccion {
  @PrimaryGeneratedColumn()
  id_seccion!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  descripcion!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
