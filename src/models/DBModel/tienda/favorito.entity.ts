import { Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Cliente } from '../cliente.entity';
import { Producto } from '../producto.entity';

@Entity('favoritos')
export class Favorito {

  @PrimaryGeneratedColumn()
  id_favorito!: number;

  @ManyToOne(() => Cliente, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @ManyToOne(() => Producto, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_producto' })
  producto!: Producto;

  @CreateDateColumn()
  creado_en!: Date;
}
