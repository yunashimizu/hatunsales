import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Documento } from '../../models/DBModel/documento.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';
import { IClienteRepository } from '../Irepository/IClienteRepository';
import { Empresa } from 'src/models/DBModel/empresa.entity';

@Injectable()
export class ClienteRepository extends CrudRepository<Cliente> implements IClienteRepository {

  constructor(
    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    @InjectRepository(Documento, 'pgConnection')
    private readonly documentoRepo: Repository<Documento>,
  ) {
    super(clienteRepo);
  }

  override async getAll(): Promise<Cliente[]> {
    return this.clienteRepo.find({
      relations: ['documento', 'usuario'],
      order: { id_cliente: 'ASC' },
    });
  }

  override async getById(id: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { id_cliente: id },
      relations: ['documento', 'usuario'],
    });
  }

  async buscarPorDni(dni: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { dni },
      relations: ['documento', 'usuario'],
    });
  }

  async buscarPorEmail(email: string): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { email },
      relations: ['documento', 'usuario'],
    });
  }

  async buscarPorUsuario(id_usuario: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { usuario: { id_usuario } } as any,
      relations: ['documento', 'usuario'],
    });
  }

  async guardarConDocumento(
    data: Partial<Cliente>,
    tipoDoc: string,
    numeroDoc: number,
  ): Promise<Cliente> {
    const doc = this.documentoRepo.create({
      tipo_documento:   tipoDoc,
      numero_documento: numeroDoc,
    });
    const docGuardado = await this.documentoRepo.save(doc);

    const cliente = this.clienteRepo.create({
      ...data,
      documento: docGuardado,
    });
    return this.clienteRepo.save(cliente);
  }

  async guardarSinDocumento(data: Partial<Cliente>): Promise<Cliente> {
    const cliente = this.clienteRepo.create(data);
    return this.clienteRepo.save(cliente);
  }

  async actualizar(id: number, data: Partial<Cliente>): Promise<Cliente> {
    await this.clienteRepo.update(id, data as any);
    return this.getById(id) as Promise<Cliente>;
  }

  override async delete(id: number): Promise<number> {
    const result = await this.clienteRepo.delete(id);
    return result.affected ?? 0;
  }

  async buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
  return this.clienteRepo.manager.findOne(Empresa, { where: { ruc } });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    const nueva = this.clienteRepo.manager.create(Empresa, data);
    return this.clienteRepo.manager.save(Empresa, nueva);
  }
}