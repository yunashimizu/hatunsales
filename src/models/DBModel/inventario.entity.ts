import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from './producto.entity';

@Entity('inventarios')
export class Inventario {

  @PrimaryGeneratedColumn()
  id_inventario!: number;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ type: 'integer', default: 0 })
  stock_minimo!: number;

  @CreateDateColumn()
  creado_en!: Date;
}
