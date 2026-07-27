import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from './producto.entity';
import { Almacen } from './almacen.entity';

@Entity('inventario')
export class Inventario {

  @PrimaryGeneratedColumn()
  id_inventario!: number;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @ManyToOne(() => Almacen, { nullable: true })
  @JoinColumn({ name: 'id_almacen' })
  almacen!: Almacen;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ type: 'integer', default: 0 })
  stock_minimo!: number;

  @CreateDateColumn()
  creado_en!: Date;
}
