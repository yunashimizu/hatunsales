import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Producto } from '../producto.entity';
import { Pedido } from './pedido.entity';

@Entity('pedido_items')
export class PedidoItem {

  @PrimaryGeneratedColumn()
  id_pedido_item!: number;

  @ManyToOne(() => Pedido, (pedido) => pedido.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_pedido' })
  pedido!: Pedido;

  @ManyToOne(() => Producto, { nullable: true })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ nullable: true })
  nombre_producto!: string;

  @Column({ nullable: true })
  imagen_url!: string;

  @Column({ type: 'integer', default: 1 })
  cantidad!: number;

  @Column({ type: 'numeric', default: 0 })
  precio_unitario!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  descuento!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  subtotal!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  igv!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  total!: number;

  /** Almacén del que se descontó el stock, para devolverlo al mismo si se cancela. */
  @Column({ nullable: true, type: 'integer' })
  id_almacen!: number;
}
