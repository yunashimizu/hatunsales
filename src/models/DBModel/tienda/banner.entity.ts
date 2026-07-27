import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('banners')
export class Banner {

  @PrimaryGeneratedColumn()
  id_banner!: number;

  @Column({ nullable: true })
  titulo!: string;

  @Column({ nullable: true })
  subtitulo!: string;

  @Column({ nullable: true })
  etiqueta!: string;

  @Column({ nullable: true })
  imagen_url!: string;

  @Column({ nullable: true })
  cta_texto!: string;

  @Column({ nullable: true })
  cta_url!: string;

  @Column({ nullable: true, type: 'integer', default: 0 })
  orden!: number;

  @Column({ nullable: true, default: true })
  activo!: boolean;

  @Column({ nullable: true, type: 'date' })
  fecha_inicio!: Date;

  @Column({ nullable: true, type: 'date' })
  fecha_fin!: Date;

  @CreateDateColumn()
  creado_en!: Date;
}
