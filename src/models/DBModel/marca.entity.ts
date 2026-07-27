import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('marcas')
export class Marca {
  @PrimaryGeneratedColumn()
  id_marca!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  slug!: string;

  @Column({ nullable: true })
  logo_url!: string;

  @Column({ nullable: true, default: true })
  activo!: boolean;

  @CreateDateColumn()
  creado_en!: Date;
}
