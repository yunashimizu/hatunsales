import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { ProductoImagen } from './producto-imagen.entity';
import { Categoria } from './categoria.entity';
import { Marca } from './marca.entity';

@Entity('productos')
export class Producto {

  @PrimaryGeneratedColumn()
  id_producto!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  descripcion!: string;

  @Column({ nullable: true })
  descripcion_corta!: string;

  @Column({ nullable: true })
  codigo_barras!: string;

  @Column({ nullable: true })
  sku!: string;

  @Column({ nullable: true })
  slug!: string;

  @Column({ nullable: true, type: 'numeric' })
  precio_compra!: number;

  @Column({ nullable: true, type: 'numeric' })
  precio_venta!: number;

  @Column({ nullable: true, type: 'numeric' })
  descuento!: number;

  @Column({ nullable: true, default: false })
  destacado!: boolean;

  @Column({ nullable: true, default: true })
  estado!: boolean;

  @Column({ nullable: true })
  unidad_medida!: string;

  @Column({ nullable: true, type: 'integer' })
  id_unidad!: number;

  @ManyToOne(() => Categoria, { nullable: true })
  @JoinColumn({ name: 'id_categoria' })
  categoria!: Categoria;

  @ManyToOne(() => Marca, { nullable: true })
  @JoinColumn({ name: 'id_marca' })
  marca!: Marca;

  @OneToMany(() => ProductoImagen, (img) => img.producto)
  imagenes!: ProductoImagen[];

  @CreateDateColumn()
  creado_en!: Date;
}
