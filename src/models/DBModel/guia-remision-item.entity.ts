import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { GuiaRemision } from './guia-remision.entity';
import { Producto } from './producto.entity';

@Entity('guias_remision_items')
export class GuiaRemisionItem {

  @PrimaryGeneratedColumn()
  id_item!: number;

  @ManyToOne(() => GuiaRemision, (guia) => guia.items, { nullable: false })
  @JoinColumn({ name: 'id_guia' })
  guia!: GuiaRemision;

  @ManyToOne(() => Producto, { nullable: true })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @Column({ type: 'numeric' })
  cantidad!: number;

  @Column({ nullable: true })
  unidad_medida!: string;

  @Column({ nullable: true })
  id_venta_detalle!: number;

  @Column({ nullable: true })
  codigo!: string;

  @Column({ nullable: true, type: 'text' })
  descripcion!: string;

  @Column({ nullable: true, type: 'integer' })
  orden!: number;
}
