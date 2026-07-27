import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Pedido } from './pedido.entity';

@Entity('pedido_estados')
export class PedidoEstado {

  @PrimaryGeneratedColumn()
  id_estado!: number;

  @ManyToOne(() => Pedido, (pedido) => pedido.historial, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_pedido' })
  pedido!: Pedido;

  @Column()
  estado!: string;

  @Column({ nullable: true })
  comentario!: string;

  @CreateDateColumn()
  creado_en!: Date;
}
