import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('log')
export class Log {

  @PrimaryGeneratedColumn()
  idlog!: number;

  @Column()
  accion!: string;

  @Column()
  entidad!: string;

  @CreateDateColumn()
  fecha!: Date;
}