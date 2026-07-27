import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('metodos_pago')
export class MetodoPago {

  @PrimaryGeneratedColumn()
  id_metodo!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  tipo!: string;

  @Column({ nullable: true })
  descripcion!: string;

  @Column({ nullable: true })
  logo_url!: string;

  @Column({ nullable: true, default: true })
  activo!: boolean;

  @Column({ nullable: true, type: 'integer', default: 0 })
  orden!: number;
}
