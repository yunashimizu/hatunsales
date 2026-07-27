import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('metodos_envio')
export class MetodoEnvio {

  @PrimaryGeneratedColumn()
  id_metodo_envio!: number;

  @Column()
  nombre!: string;

  @Column({ nullable: true })
  descripcion!: string;

  @Column({ nullable: true, type: 'numeric', default: 0 })
  costo!: number;

  @Column({ nullable: true, type: 'integer', default: 1 })
  dias_min!: number;

  @Column({ nullable: true, type: 'integer', default: 3 })
  dias_max!: number;

  @Column({ nullable: true, default: true })
  activo!: boolean;

  @Column({ nullable: true, type: 'integer', default: 0 })
  orden!: number;
}
