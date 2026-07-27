import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Cliente } from '../cliente.entity';
import { Producto } from '../producto.entity';

@Entity('resenas')
export class Resena {

  @PrimaryGeneratedColumn()
  id_resena!: number;

  @ManyToOne(() => Producto, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @ManyToOne(() => Cliente, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ type: 'smallint' })
  calificacion!: number;

  @Column({ nullable: true })
  titulo!: string;

  @Column({ nullable: true })
  comentario!: string;

  @Column({ nullable: true, default: true })
  aprobado!: boolean;

  /** Pedido entregado que respalda la opinión. */
  @Column({ nullable: true, type: 'integer' })
  id_pedido!: number;

  @Column({ nullable: true, type: 'boolean', default: false })
  compra_verificada!: boolean;

  @CreateDateColumn()
  creado_en!: Date;
}
