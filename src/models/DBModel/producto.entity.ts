import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { ProductoImagen } from './producto-imagen.entity';

@Entity('productos')
export class Producto {

  @PrimaryGeneratedColumn()
  id_producto!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  descripcion!: string;

  @Column({ nullable: true })
  codigo_barras!: string;

  @Column({ nullable: true })
  sku!: string;

  @Column({ nullable: true, type: 'numeric' })
  precio_compra!: number;

  @Column({ nullable: true, type: 'numeric' })
  precio_venta!: number;

  @Column({ nullable: true })
  unidad_medida!: string;

  @OneToMany(() => ProductoImagen, (img) => img.producto)
  imagenes!: ProductoImagen[];

  @CreateDateColumn()
  creado_en!: Date;
}
