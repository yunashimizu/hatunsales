import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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
    // Quien llama buscó el DNI, consultó SUNAT y recién guarda: con el candado (misma clave que
    // ReceptorRepository) y la búsqueda repetida aquí dentro, dos locales no crean dos fichas.
    return this.clienteRepo.manager.transaction(async (manager) => {
      await bloquearDocumento(manager, `cliente-dni:${Number(dniData.dni)}`);
      const clientes = manager.getRepository(Cliente);
      const existente = await clientes.findOne({ where: { dni: dniData.dni }, relations: ['documento'] });
      if (existente) return existente;

      // primero crea el documento
      const documentos = manager.getRepository(Documento);
      const docGuardado = await documentos.save(documentos.create({
        tipo_documento: 'DNI',
        numero_documento: dniData.dni,
      }));

      // luego crea el cliente con el documento
      return clientes.save(clientes.create({
        nombre: dniData.nombre,
        apellido_paterno: dniData.apellido_paterno,
        apellido_materno: dniData.apellido_materno,
        dni: dniData.dni,
        telefono: dniData.telefono ?? '',
        email: dniData.email ?? '',
        direccion: dniData.direccion ?? '',
        documento: docGuardado,
      }));
    });
  }

  // ── Empresa ──────────────────────────────────────────────────

  async buscarEmpresaPorRuc(ruc: string): Promise<Empresa | null> {
    return this.empresaRepo.findOne({ where: { ruc } });
  }

  async guardarEmpresa(data: Partial<Empresa>): Promise<Empresa> {
    if (!data.ruc) return this.empresaRepo.save(this.empresaRepo.create(data));
    const ruc = String(data.ruc);
    // Mismo candado que ReceptorRepository: si otro local la guardó mientras se consultaba SUNAT, se devuelve esa.
    return this.empresaRepo.manager.transaction(async (manager) => {
      await bloquearDocumento(manager, `empresa-ruc:${ruc}`);
      const empresas = manager.getRepository(Empresa);
      const existente = await empresas.findOne({ where: { ruc } });
      if (existente) return existente;
      return empresas.save(empresas.create(data));
    });
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

/** Candado consultivo por documento, hasta el fin de la transacción. */
async function bloquearDocumento(manager: EntityManager, clave: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clave]);
}
