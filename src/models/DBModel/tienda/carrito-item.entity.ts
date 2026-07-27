import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from '../producto.entity';
import { Carrito } from './carrito.entity';

@Entity('carrito_items')
export class CarritoItem {

  @PrimaryGeneratedColumn()
  id_item!: number;

  @ManyToOne(() => Carrito, (carrito) => carrito.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_carrito' })
  carrito!: Carrito;

  @ManyToOne(() => Producto, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ type: 'integer', default: 1 })
  cantidad!: number;

  @Column({ type: 'numeric', default: 0 })
  precio_unitario!: number;

  @CreateDateColumn()
  creado_en!: Date;
}
