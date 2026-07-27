import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany, CreateDateColumn } from 'typeorm';
import { Cliente } from '../cliente.entity';
import { DireccionEnvio } from './direccion-envio.entity';
import { MetodoEnvio } from './metodo-envio.entity';
import { MetodoPago } from './metodo-pago.entity';
import { Cupon } from './cupon.entity';
import { PedidoItem } from './pedido-item.entity';
import { PedidoEstado } from './pedido-estado.entity';

@Entity('pedidos')
export class Pedido {

  @PrimaryGeneratedColumn()
  id_pedido!: number;

  @Column({ unique: true })
  codigo!: string;

  @ManyToOne(() => Cliente, { nullable: false })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @ManyToOne(() => DireccionEnvio, { nullable: true })
  @JoinColumn({ name: 'id_direccion' })
  direccion!: DireccionEnvio;

  @ManyToOne(() => MetodoEnvio, { nullable: true })
  @JoinColumn({ name: 'id_metodo_envio' })
  metodo_envio!: MetodoEnvio;

  @ManyToOne(() => MetodoPago, { nullable: true })
  @JoinColumn({ name: 'id_metodo_pago' })
  metodo_pago!: MetodoPago;

  @ManyToOne(() => Cupon, { nullable: true })
  @JoinColumn({ name: 'id_cupon' })
  cupon!: Cupon;

  @Column({ nullable: true, type: 'integer' })
  id_venta!: number;

  @Column({ nullable: true, type: 'integer' })
  id_comprobante!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  subtotal!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  igv!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  descuento!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  costo_envio!: number;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  total!: number;

  /** pendiente | pagado | preparando | enviado | entregado | cancelado */
  @Column({ nullable: true, default: 'pendiente' })
  estado!: string;

  @Column({ nullable: true, default: 'boleta' })
  tipo_comprobante!: string;

  @Column({ nullable: true })
  documento_receptor!: string;

  @Column({ nullable: true })
  nombre_receptor!: string;

  @Column({ nullable: true })
  notas!: string;

  /**
   * Identificador que envía el navegador para cada intento de compra. Si el
   * cliente reintenta por mala conexión, la clave llega repetida y el pedido
   * ya creado se devuelve tal cual en lugar de generar uno nuevo.
   */
  @Column({ nullable: true })
  clave_idempotencia!: string;

  @Column({ nullable: true, type: 'boolean', default: false })
  stock_reservado!: boolean;

  @Column({ nullable: true, type: 'integer' })
  id_almacen!: number;

  @Column({ nullable: true })
  ip_origen!: string;

  @OneToMany(() => PedidoItem, (item) => item.pedido)
  items!: PedidoItem[];

  @OneToMany(() => PedidoEstado, (estado) => estado.pedido)
  historial!: PedidoEstado[];

  @CreateDateColumn()
  creado_en!: Date;

  @Column({ nullable: true, type: 'timestamp' })
  actualizado_en!: Date;
}
