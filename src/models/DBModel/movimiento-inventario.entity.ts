import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from './producto.entity';
import { Sucursal } from './sucursal.entity';

@Entity('movimientos_inventario')
export class MovimientoInventario {
  @PrimaryGeneratedColumn()
  id_movimiento!: number;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ nullable: false })
  tipo!: string; // 'entrada' | 'salida' | 'transferencia'

  @Column({ type: 'integer' })
  cantidad!: number;

  @ManyToOne(() => Sucursal, { nullable: true })
  @JoinColumn({ name: 'id_sucursal_origen' })
  sucursal_origen!: Sucursal;

  @ManyToOne(() => Sucursal, { nullable: true })
  @JoinColumn({ name: 'id_sucursal_destino' })
  sucursal_destino!: Sucursal;

  @Column({ nullable: true, type: 'text' })
  descripcion!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
