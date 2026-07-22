import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('proveedores')
export class Proveedor {

  @PrimaryGeneratedColumn()
  id_proveedor!: number;

  @Column({ nullable: true })
  nombre!: string;

  @Column({ nullable: true })
  ruc!: string;

  @Column({ nullable: true })
  telefono!: string;

  @Column({ nullable: true })
  email!: string;

  @Column({ nullable: true })
  direccion!: string;
}