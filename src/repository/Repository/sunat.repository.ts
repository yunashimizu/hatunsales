import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Documento } from '../../models/DBModel/documento.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { Proveedor } from '../../models/DBModel/proveedor.entity';

@Injectable()
export class SunatRepository {

  constructor(
    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    @InjectRepository(Documento, 'pgConnection')
    private readonly documentoRepo: Repository<Documento>,

    @InjectRepository(Empresa, 'pgConnection')
    private readonly empresaRepo: Repository<Empresa>,

    @InjectRepository(Proveedor, 'pgConnection')
    private readonly proveedorRepo: Repository<Proveedor>,
  ) {}

  // ── Cliente ──────────────────────────────────────────────────

  async buscarClientePorDni(dni: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { dni },
      relations: ['documento'],
    });
  }

  async guardarCliente(
    dniData: {
      nombre: string;
      apellido_paterno: string;
      apellido_materno: string;
      dni: number;
      telefono?: string;
      email?: string;
      direccion?: string;
    }
  ): Promise<Cliente> {

    // primero crea el documento
    const doc = this.documentoRepo.create({
      tipo_documento: 'DNI',
      numero_documento: dniData.dni,
    });
    const docGuardado = await this.documentoRepo.save(doc);

    // luego crea el cliente con el documento
    const cliente = this.clienteRepo.create({
      nombre: dniData.nombre,
      apellido_paterno: dniData.apellido_paterno,
      apellido_materno: dniData.apellido_materno,
      dni: dniData.dni,
      telefono: dniData.telefono ?? '',
      email: dniData.email ?? '',
      direccion: dniData.direccion ?? '',
      documento: docGuardado,
    });

    return this.clienteRepo.save(cliente);
  }

  // ── Empresa ──────────────────────────────────────────────────

  async buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
    return this.empresaRepo.findOne({ where: { ruc } });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    const nueva = this.empresaRepo.create(data);
    return this.empresaRepo.save(nueva);
  }

  // ── Proveedor ────────────────────────────────────────────────

  async buscarProveedorPorRuc(ruc: string): Promise<Proveedor | null> {
    return this.proveedorRepo.findOne({ where: { ruc } });
  }

  async guardarProveedor(data: Partial<Proveedor>): Promise<Proveedor> {
    const nuevo = this.proveedorRepo.create(data);
    return this.proveedorRepo.save(nuevo);
  }
}