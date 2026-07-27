import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';

/**
 * Acceso a los dos padrones locales de receptores: personas en `clientes` y
 * empresas en `empresas`.
 */
@Injectable()
export class ReceptorRepository {

  constructor(
    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    @InjectRepository(Empresa, 'pgConnection')
    private readonly empresaRepo: Repository<Empresa>,
  ) {}

  // ── Clientes ─────────────────────────────────────────────────

  buscarClientePorId(id_cliente: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({ where: { id_cliente } });
  }

  buscarClientePorDni(dni: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({ where: { dni } });
  }

  async guardarCliente(data: Partial<Cliente>): Promise<Cliente> {
    const existente = data.dni ? await this.buscarClientePorDni(Number(data.dni)) : null;

    if (existente) {
      // Solo se sobrescriben los campos que traen valor, para no borrar el
      // teléfono o la dirección que alguien cargó a mano.
      const cambios = Object.fromEntries(
        Object.entries(data).filter(([, valor]) => valor !== undefined && valor !== null && valor !== ''),
      );
      await this.clienteRepo.update(existente.id_cliente, cambios);
      return this.buscarClientePorId(existente.id_cliente) as Promise<Cliente>;
    }

    return this.clienteRepo.save(this.clienteRepo.create(data));
  }

  async actualizarCliente(id_cliente: number, data: Partial<Cliente>): Promise<Cliente | null> {
    await this.clienteRepo.update(id_cliente, data);
    return this.buscarClientePorId(id_cliente);
  }

  sugerirClientes(termino: string, limite: number): Promise<Cliente[]> {
    const patron = `%${termino.toLowerCase()}%`;
    return this.clienteRepo
      .createQueryBuilder('c')
      .where(
        `LOWER(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido_paterno, '') || ' ' || COALESCE(c.apellido_materno, '')) LIKE :patron
         OR CAST(c.dni AS TEXT) LIKE :patron`,
        { patron },
      )
      .orderBy('c.creado_en', 'DESC')
      .limit(limite)
      .getMany();
  }

  // ── Empresas ─────────────────────────────────────────────────

  buscarEmpresaPorId(id_empresa: number): Promise<Empresa | null> {
    return this.empresaRepo.findOne({ where: { id_empresa } });
  }

  buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
    return this.empresaRepo.findOne({ where: { ruc } });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    const existente = data.ruc ? await this.buscarEmpresaPorRuc(String(data.ruc)) : null;

    if (existente) {
      const cambios = Object.fromEntries(
        Object.entries(data).filter(([, valor]) => valor !== undefined && valor !== null && valor !== ''),
      );
      await this.empresaRepo.update(existente.id_empresa, cambios);
      return this.buscarEmpresaPorId(existente.id_empresa) as Promise<Empresa>;
    }

    return this.empresaRepo.save(this.empresaRepo.create(data));
  }

  async actualizarEmpresa(id_empresa: number, data: Partial<Empresa>): Promise<Empresa | null> {
    await this.empresaRepo.update(id_empresa, data);
    return this.buscarEmpresaPorId(id_empresa);
  }

  sugerirEmpresas(termino: string, limite: number): Promise<Empresa[]> {
    const patron = `%${termino.toLowerCase()}%`;
    return this.empresaRepo
      .createQueryBuilder('e')
      .where(
        `LOWER(COALESCE(e.razon_social, '')) LIKE :patron
         OR LOWER(COALESCE(e.nombre_comercial, '')) LIKE :patron
         OR e.ruc LIKE :patron`,
        { patron },
      )
      .orderBy('e.creado_en', 'DESC')
      .limit(limite)
      .getMany();
  }

  listarEmpresas(limite = 200): Promise<Empresa[]> {
    return this.empresaRepo.find({ order: { creado_en: 'DESC' }, take: limite });
  }
}
