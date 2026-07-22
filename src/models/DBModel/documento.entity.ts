import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('documento')
export class Documento {

  @PrimaryGeneratedColumn()
  id_documento!: number;

  @Column({ nullable: true })
  tipo_documento!: string;

  @Column({ nullable: true, type: 'numeric' })
  numero_documento!: number;
}