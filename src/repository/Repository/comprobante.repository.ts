import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from '../../models/DBModel/c-electronico/comprobante-item.entity';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class ComprobanteRepository extends CrudRepository<Comprobante> {

  constructor(
    @InjectRepository(Comprobante, 'pgConnection')
    private readonly comprobanteRepo: Repository<Comprobante>,

    @InjectRepository(ComprobanteItem, 'pgConnection')
    private readonly itemRepo: Repository<ComprobanteItem>,
  ) {
    super(comprobanteRepo);
  }

  // ── Cliente ──────────────────────────────────────────────────

  async buscarClientePorId(id_cliente: number): Promise<Cliente | null> {
    return this.comprobanteRepo.manager.findOne(Cliente, {
      where: { id_cliente },
      relations: ['documento'],
    });
  }

  async buscarClientePorDni(dni: number): Promise<Cliente | null> {
    return this.comprobanteRepo.manager.findOne(Cliente, {
      where: { dni },
      relations: ['documento'],
    });
  }

  async guardarCliente(data: Partial<Cliente>): Promise<Cliente> {
    const existe = data.dni
      ? await this.buscarClientePorDni(data.dni as number)
      : null;

    if (existe) {
      await this.comprobanteRepo.manager.update(Cliente, existe.id_cliente, data);
      return this.comprobanteRepo.manager.findOne(Cliente, {
        where: { id_cliente: existe.id_cliente },
      }) as Promise<Cliente>;
    }

    const nuevo = this.comprobanteRepo.manager.create(Cliente, data);
    return this.comprobanteRepo.manager.save(Cliente, nuevo);
  }

  // ── Empresa ──────────────────────────────────────────────────

  async buscarEmpresaPorId(id_empresa: number): Promise<Empresa | null> {
    return this.comprobanteRepo.manager.findOne(Empresa, {
      where: { id_empresa },
    });
  }

  async buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
    return this.comprobanteRepo.manager.findOne(Empresa, {
      where: { ruc },
    });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    const existe = data.ruc
      ? await this.buscarEmpresaPorRuc(data.ruc as string)
      : null;

    if (existe) {
      await this.comprobanteRepo.manager.update(Empresa, existe.id_empresa, data);
      return this.comprobanteRepo.manager.findOne(Empresa, {
        where: { id_empresa: existe.id_empresa },
      }) as Promise<Empresa>;
    }

    const nueva = this.comprobanteRepo.manager.create(Empresa, data);
    return this.comprobanteRepo.manager.save(Empresa, nueva);
  }

  // ── Comprobante ──────────────────────────────────────────────

  async buscarPorSerieNumero(serie: string, numero: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { serie, numero },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
    });
  }

  async guardarConItems(
    data: Partial<Comprobante>,
    items: Partial<ComprobanteItem>[],
  ): Promise<Comprobante> {
    const nuevo = this.comprobanteRepo.create(data);
    const guardado = await this.comprobanteRepo.save(nuevo);

    const itemsEntidad = items.map((i) =>
      this.itemRepo.create({ ...i, comprobante: guardado })
    );
    await this.itemRepo.save(itemsEntidad);

    return this.comprobanteRepo.findOne({
      where: { id_comprobante: guardado.id_comprobante },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
    }) as Promise<Comprobante>;
  }

  async actualizarRespuesta(id: number, data: Partial<Comprobante>): Promise<void> {
    await this.comprobanteRepo.update(id, data);
  }

  async listarPorVenta(id_venta: number): Promise<Comprobante[]> {
    return this.comprobanteRepo.find({
      where: { id_venta },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
      order: { creado_en: 'DESC' },
    });
  }

  async listarPorCliente(id_cliente: number): Promise<Comprobante[]> {
    return this.comprobanteRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.items', 'items')
      .leftJoinAndSelect('c.tipo', 'tipo')
      .leftJoinAndSelect('c.moneda', 'moneda')
      .where('c.id_cliente = :id_cliente', { id_cliente })
      .orderBy('c.creado_en', 'DESC')
      .getMany();
  }

  async buscarPorId(id_comprobante: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { id_comprobante },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
    });
  }
}