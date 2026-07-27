import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Pedido } from './pedido.entity';
import { MetodoPago } from './metodo-pago.entity';

@Entity('pedido_pagos')
export class PedidoPago {

  @PrimaryGeneratedColumn()
  id_pago!: number;

  @ManyToOne(() => Pedido, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_pedido' })
  pedido!: Pedido;

  @ManyToOne(() => MetodoPago, { nullable: true })
  @JoinColumn({ name: 'id_metodo' })
  metodo!: MetodoPago;

  @Column({ type: 'numeric', default: 0 })
  monto!: number;

  /** pendiente | aprobado | rechazado */
  @Column({ nullable: true, default: 'pendiente' })
  estado!: string;

  @Column({ nullable: true })
  referencia!: string;

  /** manual | simulada | culqi | … */
  @Column({ nullable: true, default: 'manual' })
  proveedor!: string;

  /** Id del cargo en la pasarela; evita registrar dos veces el mismo pago. */
  @Column({ nullable: true })
  referencia_externa!: string;

  @Column({ nullable: true })
  clave_idempotencia!: string;

  @Column({ nullable: true, default: 'PEN' })
  moneda!: string;

  @Column({ nullable: true })
  mensaje!: string;

  @Column({ nullable: true, type: 'jsonb' })
  respuesta!: Record<string, any>;

  @CreateDateColumn()
  creado_en!: Date;

  @Column({ nullable: true, type: 'timestamp' })
  actualizado_en!: Date;
}
