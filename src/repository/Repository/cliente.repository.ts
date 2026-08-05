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

  /** Conteos seguros (tabla ausente → 0) para bloquear hard-delete con historial. */
  async contarReferenciasCliente(idCliente: number): Promise<{ total: number; detalle: string }> {
    const partes: string[] = [];
    let total = 0;

    const checks: Array<{ etiqueta: string; sql: string }> = [
      { etiqueta: 'ventas', sql: 'SELECT COUNT(*)::int AS c FROM ventas WHERE id_cliente = $1' },
      {
        etiqueta: 'créditos',
        sql: 'SELECT COUNT(*)::int AS c FROM cuentas_por_cobrar WHERE id_cliente = $1',
      },
      {
        etiqueta: 'comprobantes',
        sql: 'SELECT COUNT(*)::int AS c FROM comprobantes WHERE id_cliente = $1',
      },
      { etiqueta: 'pedidos', sql: 'SELECT COUNT(*)::int AS c FROM pedidos WHERE id_cliente = $1' },
      { etiqueta: 'proformas', sql: 'SELECT COUNT(*)::int AS c FROM proformas WHERE id_cliente = $1' },
    ];

    for (const check of checks) {
      const n = await this.contarSeguro(check.sql, idCliente);
      if (n > 0) {
        total += n;
        partes.push(`${check.etiqueta}: ${n}`);
      }
    }

    return { total, detalle: partes.join(', ') || 'sin detalle' };
  }

  async desactivarUsuarioSiExiste(idUsuario: number): Promise<void> {
    try {
      await this.clienteRepo.manager.query(
        `UPDATE usuarios SET estado = false WHERE id_usuario = $1`,
        [idUsuario],
      );
    } catch {
      /* tabla/columna distinta: no tumbar el delete del cliente */
    }
  }

  private async contarSeguro(sql: string, id: number): Promise<number> {
    try {
      const filas = await this.clienteRepo.manager.query(sql, [id]);
      return Number(filas?.[0]?.c ?? 0);
    } catch {
      return 0;
    }
  }

  async buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
  return this.clienteRepo.manager.findOne(Empresa, { where: { ruc } });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    const nueva = this.clienteRepo.manager.create(Empresa, data);
    return this.clienteRepo.manager.save(Empresa, nueva);
  }
}