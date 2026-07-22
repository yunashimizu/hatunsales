import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('sucursales')
export class Sucursal {
  @PrimaryGeneratedColumn()
  id_sucursal!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  direccion!: string;

  @Column({ nullable: true })
  telefono!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
