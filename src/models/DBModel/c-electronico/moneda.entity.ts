import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('monedas')
export class Moneda {

  @PrimaryGeneratedColumn()
  id_moneda!: number;

  @Column()
  nombre!: string;

  @Column()
  simbolo!: string;
}