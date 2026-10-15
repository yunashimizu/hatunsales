import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CajaArqueo } from './caja-arqueo.entity';

/** Conteo de una denominación (billete o moneda de soles) dentro de un arqueo. */
@Entity('caja_arqueo_denominaciones')
export class CajaArqueoDenominacion {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  id_arqueo!: number;

  /** 'billete' | 'moneda' */
  @Column({ type: 'varchar', length: 10 })
  tipo!: 'billete' | 'moneda';

  /** Valor en soles: '200.00' … '0.10'. */
  @Column({ type: 'numeric', precision: 8, scale: 2 })
  denominacion!: string;

  @Column({ type: 'int' })
  cantidad!: number;

  /** denominacion × cantidad (CHECK en la BD). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  subtotal!: string;

  @ManyToOne(() => CajaArqueo, (a) => a.denominaciones, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_arqueo' })
  arqueo?: CajaArqueo;
}
