import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from './producto.entity';
import { Sucursal } from './sucursal.entity';

@Entity('stock_sucursal')
export class StockSucursal {
  @PrimaryGeneratedColumn()
  id_stock!: number;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @ManyToOne(() => Sucursal, { nullable: false })
  @JoinColumn({ name: 'id_sucursal' })
  sucursal!: Sucursal;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ type: 'integer', default: 0 })
  stock_comprometido!: number;

  @CreateDateColumn()
  actualizado_en!: Date;
}
