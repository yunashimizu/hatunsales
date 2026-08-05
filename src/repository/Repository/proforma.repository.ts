import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Proforma } from '../../models/DBModel/proforma.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class ProformaRepository extends CrudRepository<Proforma> {
  private schemaOk = false;

  constructor(
    @InjectRepository(Proforma, 'pgConnection')
    private readonly proformaRepo: Repository<Proforma>,
  ) {
    super(proformaRepo);
  }

  async asegurarSchema(): Promise<void> {
    if (this.schemaOk) return;
    const q = this.proformaRepo.manager.query.bind(this.proformaRepo.manager);
    const stmts = [
      `ALTER TABLE proformas ALTER COLUMN id_cliente DROP NOT NULL`,
      `ALTER TABLE proformas ALTER COLUMN id_empresa DROP NOT NULL`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS codigo VARCHAR(32)`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'borrador'`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS observaciones TEXT`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS valida_hasta DATE`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_almacen INTEGER`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot VARCHAR(250)`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS telefono_envio VARCHAR(32)`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_venta INTEGER`,
      `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS enviada_wa_en TIMESTAMPTZ`,
      `ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS descripcion_snapshot VARCHAR(250)`,
      `ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS sku_snapshot VARCHAR(80)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_proformas_codigo ON proformas (codigo) WHERE codigo IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_proformas_estado ON proformas (estado)`,
    ];
    for (const sql of stmts) {
      await q(sql).catch(() => undefined);
    }
    this.schemaOk = true;
  }

  async getAll(): Promise<Proforma[]> {
    await this.asegurarSchema();
    return this.proformaRepo.find({
      relations: ['cliente', 'empresa', 'items', 'items.producto'],
      order: { id_proforma: 'DESC' },
      take: 200,
    });
  }

  async getById(id: number): Promise<Proforma | null> {
    await this.asegurarSchema();
    return this.proformaRepo.findOne({
      where: { id_proforma: id },
      relations: ['cliente', 'empresa', 'items', 'items.producto'],
    });
  }

  async guardarConItems(data: Partial<Proforma>): Promise<Proforma> {
    await this.asegurarSchema();
    const nueva = this.proformaRepo.create(data);
    const guardada = await this.proformaRepo.save(nueva);
    return this.getById(guardada.id_proforma) as Promise<Proforma>;
  }

  async actualizar(id: number, data: Partial<Proforma>): Promise<Proforma | null> {
    await this.asegurarSchema();
    await this.proformaRepo.update(id, data as any);
    return this.getById(id);
  }

  async siguienteNumero(): Promise<number> {
    await this.asegurarSchema();
    const filas = await this.proformaRepo.manager.query(
      `SELECT COALESCE(MAX(numero), 0)::int + 1 AS n FROM proformas`,
    );
    return Number(filas?.[0]?.n ?? 1);
  }
}
