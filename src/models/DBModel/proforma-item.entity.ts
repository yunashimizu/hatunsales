import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Proforma } from './proforma.entity';
import { Producto } from './producto.entity';

@Entity('proformas_items')
export class ProformaItem {

  @PrimaryGeneratedColumn()
  id_item!: number;

  @ManyToOne(() => Proforma, (proforma) => proforma.items, { nullable: false })
  @JoinColumn({ name: 'id_proforma' })
  proforma!: Proforma;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ type: 'integer' })
  cantidad!: number;

  @Column({ type: 'numeric' })
  precio_unitario!: number;

  @Column({ type: 'numeric' })
  subtotal!: number;
}
