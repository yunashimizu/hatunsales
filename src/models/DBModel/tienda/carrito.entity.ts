import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany, CreateDateColumn } from 'typeorm';
import { Cliente } from '../cliente.entity';
import { CarritoItem } from './carrito-item.entity';

@Entity('carritos')
export class Carrito {

  @PrimaryGeneratedColumn()
  id_carrito!: number;

  @ManyToOne(() => Cliente, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ nullable: true })
  token_invitado!: string;

  /** activo | convertido | abandonado */
  @Column({ nullable: true, default: 'activo' })
  estado!: string;

  @OneToMany(() => CarritoItem, (item) => item.carrito)
  items!: CarritoItem[];

  @CreateDateColumn()
  creado_en!: Date;

  @Column({ nullable: true, type: 'timestamp' })
  actualizado_en!: Date;
}
