import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Sucursal } from './sucursal.entity';

@Entity('almacenes')
export class Almacen {

  @PrimaryGeneratedColumn()
  id_almacen!: number;

  @ManyToOne(() => Sucursal, { nullable: true })
  @JoinColumn({ name: 'id_sucursal' })
  sucursal!: Sucursal;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  descripcion!: string;
}
