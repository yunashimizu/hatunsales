import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import { TipoComprobante } from './tipos-comprobante.entity';
import { Moneda } from './moneda.entity';
import { Cliente } from '../cliente.entity';
import { ComprobanteItem } from './comprobante-item.entity';

@Entity('comprobantes')
export class Comprobante {

  @PrimaryGeneratedColumn()
  id_comprobante!: number;

  @Column({ nullable: true })
  id_venta!: number;

  @ManyToOne(() => Cliente, { nullable: true })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @ManyToOne(() => TipoComprobante)
  @JoinColumn({ name: 'id_tipo' })
  tipo!: TipoComprobante;

  @ManyToOne(() => Moneda)
  @JoinColumn({ name: 'id_moneda' })
  moneda!: Moneda;

  @Column()
  serie!: string;

  @Column()
  numero!: number;

  @Column({ default: 1 })
  sunat_transaction!: number;

  @Column()
  cliente_tipo_doc!: number;

  @Column()
  cliente_numero_doc!: string;

  @Column()
  cliente_denominacion!: string;

  @Column({ nullable: true })
  cliente_direccion!: string;

  @Column({ nullable: true })
  cliente_email!: string;

  @Column()
  fecha_de_emision!: string;

  @Column({ nullable: true })
  fecha_de_vencimiento!: string;

  @Column({ type: 'numeric', default: 18.00 })
  porcentaje_igv!: number;

  @Column({ type: 'numeric', nullable: true })
  total_gravada!: number;

  @Column({ type: 'numeric', nullable: true })
  total_igv!: number;

  @Column({ type: 'numeric', nullable: true })
  total!: number;

  @Column({ nullable: true, type: 'text' })
  observaciones!: string;

  @Column({ default: true })
  enviar_sunat!: boolean;

  @Column({ default: false })
  enviar_cliente!: boolean;

  // respuesta nubefact
  @Column({ nullable: true })
  enlace!: string;

  @Column({ nullable: true })
  enlace_pdf!: string;

  @Column({ nullable: true })
  enlace_xml!: string;

  @Column({ nullable: true })
  enlace_cdr!: string;

  @Column({ nullable: true })
  aceptada_sunat!: boolean;

  @Column({ nullable: true })
  sunat_description!: string;

  @Column({ nullable: true })
  sunat_responsecode!: string;

  @Column({ nullable: true, type: 'text' })
  sunat_soap_error!: string;

  @Column({ nullable: true, type: 'text' })
  cadena_qr!: string;

  @Column({ nullable: true })
  codigo_hash!: string;

  @Column({ default: false })
  anulado!: boolean;

  @Column({ nullable: true })
  motivo_anulacion!: string;

  @Column({ nullable: true })
  sunat_ticket!: string;

  @CreateDateColumn()
  creado_en!: Date;

  @OneToMany(() => ComprobanteItem, (i) => i.comprobante, { cascade: true })
  items!: ComprobanteItem[];
}