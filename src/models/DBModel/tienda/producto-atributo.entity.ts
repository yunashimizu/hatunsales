import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Producto } from '../producto.entity';

@Entity('producto_atributos')
export class ProductoAtributo {

  @PrimaryGeneratedColumn()
  id_atributo!: number;

  @ManyToOne(() => Producto, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column()
  nombre!: string;

  @Column()
  valor!: string;

  @Column({ nullable: true, default: true })
  filtrable!: boolean;

  @Column({ nullable: true, type: 'integer', default: 0 })
  orden!: number;
}
