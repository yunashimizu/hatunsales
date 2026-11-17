import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { patronContiene } from './venta-documentos.repository';

/**
 * Acceso a los dos padrones locales de receptores: personas en `clientes` y
 * empresas en `empresas`.
 *
 * Guardar por DNI o RUC toma antes un candado consultivo con esa clave (`cliente-dni:<dni>`,
 * `empresa-ruc:<ruc>`, las mismas que SunatRepository): dos locales que registran a la vez el
 * mismo documento ya no crean dos fichas (los índices de dni y ruc no son únicos).
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
    if (!data.dni) return this.clienteRepo.save(this.clienteRepo.create(data));
    const dni = Number(data.dni);

    return this.clienteRepo.manager.transaction(async (manager) => {
      await bloquearDocumento(manager, `cliente-dni:${dni}`);
      const repo = manager.getRepository(Cliente);
      const existente = await repo.findOne({ where: { dni } });

      if (existente) {
        // Solo se sobrescriben los campos que traen valor, para no borrar el
        // teléfono o la dirección que alguien cargó a mano.
        await repo.update(existente.id_cliente, soloConValor(data));
        return (await repo.findOne({ where: { id_cliente: existente.id_cliente } })) as Cliente;
      }

      return repo.save(repo.create(data));
    });
  }

  async actualizarCliente(id_cliente: number, data: Partial<Cliente>): Promise<Cliente | null> {
    await this.clienteRepo.update(id_cliente, data);
    return this.buscarClientePorId(id_cliente);
  }

  sugerirClientes(termino: string, limite: number): Promise<Cliente[]> {
    // `%`, `_` y `\` del usuario se buscan tal cual, no como comodines.
    const patron = patronContiene(termino.toLowerCase());
    return this.clienteRepo
      .createQueryBuilder('c')
      .where(
        `LOWER(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido_paterno, '') || ' ' || COALESCE(c.apellido_materno, '')) LIKE :patron ESCAPE '\\'
         OR CAST(c.dni AS TEXT) LIKE :patron ESCAPE '\\'`,
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
    if (!data.ruc) return this.empresaRepo.save(this.empresaRepo.create(data));
    const ruc = String(data.ruc);

    return this.empresaRepo.manager.transaction(async (manager) => {
      await bloquearDocumento(manager, `empresa-ruc:${ruc}`);
      const repo = manager.getRepository(Empresa);
      const existente = await repo.findOne({ where: { ruc } });

      if (existente) {
        await repo.update(existente.id_empresa, soloConValor(data));
        return (await repo.findOne({ where: { id_empresa: existente.id_empresa } })) as Empresa;
      }

      return repo.save(repo.create(data));
    });
  }

  async actualizarEmpresa(id_empresa: number, data: Partial<Empresa>): Promise<Empresa | null> {
    await this.empresaRepo.update(id_empresa, data);
    return this.buscarEmpresaPorId(id_empresa);
  }

  sugerirEmpresas(termino: string, limite: number): Promise<Empresa[]> {
    // `%`, `_` y `\` del usuario se buscan tal cual, no como comodines.
    const patron = patronContiene(termino.toLowerCase());
    return this.empresaRepo
      .createQueryBuilder('e')
      .where(
        `LOWER(COALESCE(e.razon_social, '')) LIKE :patron ESCAPE '\\'
         OR LOWER(COALESCE(e.nombre_comercial, '')) LIKE :patron ESCAPE '\\'
         OR e.ruc LIKE :patron ESCAPE '\\'`,
        { patron },
      )
      .orderBy('e.creado_en', 'DESC')
      .limit(limite)
      .getMany();
  }

  listarEmpresas(limite = 200): Promise<Empresa[]> {
    return this.empresaRepo.find({ order: { creado_en: 'DESC' }, take: limite });
  }

  async contarReferenciasEmpresa(idEmpresa: number): Promise<{ total: number; detalle: string }> {
    const partes: string[] = [];
    let total = 0;
    const checks: Array<{ etiqueta: string; sql: string }> = [
      { etiqueta: 'ventas', sql: 'SELECT COUNT(*)::int AS c FROM ventas WHERE id_empresa = $1' },
      {
        etiqueta: 'créditos',
        sql: 'SELECT COUNT(*)::int AS c FROM cuentas_por_cobrar WHERE id_empresa = $1',
      },
    ];

    for (const check of checks) {
      const n = await this.contarSeguro(check.sql, idEmpresa);
      if (n > 0) {
        total += n;
        partes.push(`${check.etiqueta}: ${n}`);
      }
    }

    return { total, detalle: partes.join(', ') || 'sin detalle' };
  }

  async eliminarEmpresa(idEmpresa: number): Promise<number> {
    const result = await this.empresaRepo.delete(idEmpresa);
    return result.affected ?? 0;
  }

  private async contarSeguro(sql: string, id: number): Promise<number> {
    try {
      const filas = await this.empresaRepo.manager.query(sql, [id]);
      return Number(filas?.[0]?.c ?? 0);
    } catch {
      return 0;
    }
  }
}

/** Candado consultivo por documento, hasta el fin de la transacción. */
async function bloquearDocumento(manager: EntityManager, clave: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clave]);
}

/** Campos que traen valor (los vacíos no pisan lo que ya estaba guardado). */
function soloConValor(data: object): Record<string, any> {
  return Object.fromEntries(
    Object.entries(data).filter(([, valor]) => valor !== undefined && valor !== null && valor !== ''),
  );
}
