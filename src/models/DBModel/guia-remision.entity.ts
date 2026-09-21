import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Cliente } from './cliente.entity';
import { Empresa } from './empresa.entity';
import { GuiaRemisionItem } from './guia-remision-item.entity';

@Entity('guias_remision')
export class GuiaRemision {

  @PrimaryGeneratedColumn()
  id_guia!: number;

  @Column({ nullable: true })
  id_venta!: number;

  @Column({ nullable: true })
  id_comprobante!: number;

  @Column({ nullable: true })
  id_almacen_origen!: number;

  @Column({ nullable: true })
  id_usuario!: number;

  @ManyToOne(() => Empresa, { nullable: true })
  @JoinColumn({ name: 'id_empresa' })
  empresa!: Empresa;

  @ManyToOne(() => Cliente, { nullable: true })
  @JoinColumn({ name: 'id_cliente' })
  cliente!: Cliente;

  @Column({ nullable: true })
  direccion_origen!: string;

  @Column({ nullable: true })
  direccion_destino!: string;

  @Column({ nullable: true })
  motivo_traslado!: string;

  @Column({ nullable: true })
  peso_total!: string;

  @Column({ nullable: true })
  direccion_envio!: string;

  @Column({ nullable: true })
  fecha!: Date;

  @Column({ nullable: true })
  tipo_guia!: string;

  @Column({ nullable: true })
  sunat_tipo_documento!: string;

  @Column({ nullable: true })
  serie!: string;

  @Column({ nullable: true, type: 'integer' })
  numero!: number;

  @Column({ nullable: true })
  estado!: string;

  @Column({ nullable: true, type: 'date' })
  fecha_emision!: string;

  @Column({ nullable: true, type: 'date' })
  fecha_inicio_traslado!: string;

  @Column({ nullable: true })
  motivo_traslado_codigo!: string;

  @Column({ nullable: true })
  modalidad_traslado!: string;

  @Column({ nullable: true })
  origen_ubigeo!: string;

  @Column({ nullable: true })
  destino_ubigeo!: string;

  @Column({ nullable: true, type: 'numeric' })
  peso_bruto_total!: number;

  @Column({ nullable: true })
  unidad_peso!: string;

  @Column({ nullable: true, type: 'numeric' })
  numero_bultos!: number;

  @Column({ nullable: true })
  destinatario_tipo_doc!: string;

  @Column({ nullable: true })
  destinatario_numero_doc!: string;

  @Column({ nullable: true })
  destinatario_denominacion!: string;

  @Column({ nullable: true })
  destinatario_direccion!: string;

  @Column({ nullable: true })
  placa_principal!: string;

  @Column({ nullable: true })
  marca_vehiculo!: string;

  @Column({ nullable: true })
  conductor_nombre!: string;

  @Column({ nullable: true })
  conductor_tipo_doc!: string;

  @Column({ nullable: true })
  conductor_numero_doc!: string;

  @Column({ nullable: true })
  conductor_licencia!: string;

  @Column({ nullable: true })
  transportista_ruc!: string;

  @Column({ nullable: true })
  transportista_denominacion!: string;

  @Column({ nullable: true, type: 'text' })
  observaciones!: string;

  @Column({ nullable: true })
  clave_idempotencia!: string;

  @Column({ nullable: true, type: 'text' })
  error_mensaje!: string;

  @Column({ nullable: true, type: 'text' })
  sunat_description!: string;

  @Column({ nullable: true })
  sunat_responsecode!: string;

  @Column({ nullable: true })
  sunat_ticket!: string;

  @Column({ nullable: true, type: 'text' })
  cadena_qr!: string;

  @Column({ nullable: true })
  codigo_hash!: string;

  @Column({ nullable: true, type: 'text' })
  enlace_pdf!: string;

  @Column({ nullable: true, type: 'text' })
  enlace_xml!: string;

  @Column({ nullable: true, type: 'text' })
  enlace_cdr!: string;

  @Column({ nullable: true })
  xml_storage_key!: string;

  @Column({ nullable: true })
  zip_storage_key!: string;

  @Column({ nullable: true })
  cdr_storage_key!: string;

  @Column({ nullable: true })
  pdf_storage_key!: string;

  @Column({ nullable: true, type: 'jsonb' })
  payload_sunat!: Record<string, any>;

  @Column({ nullable: true, type: 'jsonb' })
  respuesta_sunat!: Record<string, any>;

  @OneToMany(() => GuiaRemisionItem, (item) => item.guia, { cascade: true })
  items!: GuiaRemisionItem[];

  @CreateDateColumn()
  creado_en!: Date;
}
