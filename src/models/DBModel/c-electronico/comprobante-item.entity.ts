import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Comprobante } from './comprobante.entity';

@Entity('comprobante_items')
export class ComprobanteItem {

  @PrimaryGeneratedColumn()
  id_item!: number;

  @Column({ nullable: true })
  id_producto!: number;

  @Column({ nullable: true })
  unidad_de_medida!: string;

  @Column({ nullable: true })
  codigo!: string;

  @Column({ nullable: true })
  codigo_producto_sunat!: string;

  @Column({ nullable: true, type: 'text' })
  descripcion!: string;

  @Column({ type: 'numeric', nullable: true })
  cantidad!: number;

  @Column({ type: 'numeric', nullable: true })
  valor_unitario!: number;

  @Column({ type: 'numeric', nullable: true })
  precio_unitario!: number;

  @Column({ type: 'numeric', nullable: true })
  subtotal!: number;

  @Column({ default: 1 })
  tipo_de_igv!: number;

  @Column({ type: 'numeric', nullable: true })
  igv!: number;

  @Column({ type: 'numeric', nullable: true })
  total!: number;

  @ManyToOne(() => Comprobante, (c) => c.items)
  @JoinColumn({ name: 'id_comprobante' })
  comprobante!: Comprobante;
}