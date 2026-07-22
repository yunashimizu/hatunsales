import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('marcas')
export class Marca {
  @PrimaryGeneratedColumn()
  id_marca!: number;

  @Column({ nullable: true })
  nombre!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
