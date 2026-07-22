import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Producto } from './producto.entity';

@Entity('productos_imagenes')
export class ProductoImagen {
  @PrimaryGeneratedColumn()
  id_imagen!: number;

  @ManyToOne(() => Producto, { nullable: false })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ nullable: false })
  url!: string;

  @Column({ nullable: true })
  thumb_url!: string;

  @Column({ default: false })
  is_primary!: boolean;

  @Column({ nullable: true })
  mime!: string;

  @Column({ nullable: true, type: 'integer' })
  size!: number;

  @Column({ nullable: true, type: 'integer' })
  width!: number;

  @Column({ nullable: true, type: 'integer' })
  height!: number;

  @Column({ nullable: true })
  descripcion!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
