import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('tipos_comprobante')
export class TipoComprobante {

  @PrimaryGeneratedColumn()
  id_tipo!: number;

  @Column()
  nombre!: string;
}