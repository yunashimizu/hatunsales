import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import axios from 'axios';
import { ClienteRepository } from '../../repository/Repository/cliente.repository';
import { sunatConfig } from '../../config/sunat.config';
import { CrearClienteRequest, ActualizarClienteRequest } from '../../models/model/cliente.request';
import { ClienteResponse } from '../../models/model/cliente.response';
import { IClienteBussniees } from '../Ibussnies/IClienteBussniees';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from 'src/models/DBModel/empresa.entity';

@Injectable()
export class ClienteBussnies implements IClienteBussniees {

  constructor(private readonly repo: ClienteRepository) {}

  // ── GET ALL ──────────────────────────────────────────────────

  async getAll(): Promise<ClienteResponse[]> {
    const lista = await this.repo.getAll();
    return lista.map((c) => this.mapCliente(c));
  }

  // ── GET BY ID ────────────────────────────────────────────────

  async getById(id: number): Promise<ClienteResponse> {
    const cliente = await this.repo.getById(id);
    if (!cliente) throw new NotFoundException(`Cliente ${id} no encontrado`);
    return this.mapCliente(cliente);
  }

  // ── CREATE (manual) ──────────────────────────────────────────

  async create(dto: CrearClienteRequest): Promise<ClienteResponse> {

    if (dto.dni_sunat) return this.crearDesdeSunatDni(dto.dni_sunat);
    if (dto.ruc_sunat) return this.crearDesdeSunatRuc(dto.ruc_sunat);

    if (dto.email) {
      const existe = await this.repo.buscarPorEmail(dto.email);
      if (existe) throw new ConflictException('Ya existe un cliente con ese email');
    }

    if (dto.dni) {
      const existe = await this.repo.buscarPorDni(dto.dni);
      if (existe) throw new ConflictException('Ya existe un cliente con ese DNI');
    }

    const guardado = await this.repo.guardarConDocumento(
      {
        nombre:           dto.nombre,
        apellido_paterno: dto.apellido_paterno,
        apellido_materno: dto.apellido_materno,
        dni:              dto.dni,
        telefono:         dto.telefono ?? '',
        email:            dto.email ?? '',
        direccion:        dto.direccion ?? '',
        usuario:          dto.id_usuario ? { id_usuario: dto.id_usuario } as any : undefined,
      },
      'DNI',
      dto.dni ?? 0,
    );

    return this.mapCliente(guardado);
  }

  // ── UPDATE ───────────────────────────────────────────────────

  async update(dto: ActualizarClienteRequest, id?: number): Promise<ClienteResponse> {
    if (!id) throw new BadRequestException('Se requiere el id del cliente');

    const existe = await this.repo.getById(id);
    if (!existe) throw new NotFoundException(`Cliente ${id} no encontrado`);

    const actualizado = await this.repo.actualizar(id, {
      nombre:           dto.nombre,
      apellido_paterno: dto.apellido_paterno,
      apellido_materno: dto.apellido_materno,
      telefono:         dto.telefono,
      email:            dto.email,
      direccion:        dto.direccion,
    });

    return this.mapCliente(actualizado);
  }

  // ── DELETE ───────────────────────────────────────────────────

  async delete(id: number): Promise<number> {
    const existe = await this.repo.getById(id);
    if (!existe) throw new NotFoundException(`Cliente ${id} no encontrado`);
    return this.repo.delete(id);
  }

  // ── CREAR DESDE USUARIO (cuando se registra) ─────────────────

  async crearDesdeUsuario(id_usuario: number): Promise<ClienteResponse> {
    const existe = await this.repo.buscarPorUsuario(id_usuario);
    if (existe) return this.mapCliente(existe);

    const guardado = await this.repo.guardarSinDocumento({
      usuario: { id_usuario } as any,
    });

    return this.mapCliente(guardado);
  }

  // ── CREAR DESDE SUNAT DNI ────────────────────────────────────

  async crearDesdeSunatDni(dni: string): Promise<ClienteResponse> {
    if (dni.length !== 8) throw new BadRequestException('El DNI debe tener 8 dígitos');

    const enBD = await this.repo.buscarPorDni(Number(dni));
    if (enBD) return this.mapCliente(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.dniUrl}/${dni}?token=${sunatConfig.token}`
      );

      if (!data?.success) throw new BadRequestException('DNI no encontrado en SUNAT');

      const guardado = await this.repo.guardarConDocumento(
        {
          nombre:           data.nombres,
          apellido_paterno: data.apellidoPaterno,
          apellido_materno: data.apellidoMaterno,
          dni:              Number(dni),
        },
        'DNI',
        Number(dni),
      );

      return this.mapCliente(guardado);

    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Error al consultar SUNAT para DNI');
    }
  }

  // ── CREAR DESDE SUNAT RUC ────────────────────────────────────

async crearDesdeSunatRuc(ruc: string): Promise<any> {
  if (ruc.length !== 11) throw new BadRequestException('El RUC debe tener 11 dígitos');

  const enBD = await this.repo.buscarEmpresaPorRuc(ruc);
  if (enBD) return this.mapEmpresa(enBD);

  try {
    const { data } = await axios.get(
      `${sunatConfig.rucUrl}/${ruc}?token=${sunatConfig.token}`
    );

    if (!data?.razonSocial) throw new BadRequestException('RUC no encontrado en SUNAT');

    const guardada = await this.repo.guardarEmpresa({
      ruc:              ruc,
      razon_social:     data.razonSocial ?? '',
      nombre_comercial: data.nombreComercial ?? '',
      telefonos:        Array.isArray(data.telefonos) ? data.telefonos.join(',') : '',
      tipo:             data.tipo ?? '',
      estado:           data.estado ?? '',
      condicion:        data.condicion ?? '',
      direccion:        data.direccion ?? '',
      departamento:     data.departamento ?? '',
      provincia:        data.provincia ?? '',
      distrito:         data.distrito ?? '',
      ubigeo:           data.ubigeo ?? '',
      capital:          data.capital ?? '',
      fecha_inscripcion: data.fechaInscripcion ?? '',
      fecha_baja:       data.fechaBaja ?? '',
    });

    return this.mapEmpresa(guardada);

  } catch (error: any) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Error al consultar SUNAT para RUC');
  }
}

private mapEmpresa(e: Empresa): any {
  return {
    id_empresa:       e.id_empresa,
    ruc:              e.ruc,
    razon_social:     e.razon_social,
    nombre_comercial: e.nombre_comercial,
    telefonos:        e.telefonos ? e.telefonos.split(',') : [],
    tipo:             e.tipo,
    estado:           e.estado,
    condicion:        e.condicion,
    direccion:        e.direccion,
    departamento:     e.departamento,
    provincia:        e.provincia,
    distrito:         e.distrito,
    ubigeo:           e.ubigeo,
    capital:          e.capital,
    fecha_inscripcion: e.fecha_inscripcion,
    fecha_baja:       e.fecha_baja,
  };
}
  // ── Mapper privado ───────────────────────────────────────────

  private mapCliente(c: Cliente): ClienteResponse {
    return {
      id_cliente:       c.id_cliente,
      nombre:           c.nombre ?? '',
      apellido_paterno: c.apellido_paterno ?? '',
      apellido_materno: c.apellido_materno ?? '',
      nombre_completo:  `${c.nombre ?? ''} ${c.apellido_paterno ?? ''} ${c.apellido_materno ?? ''}`.trim(),
      dni:              c.dni,
      telefono:         c.telefono ?? '',
      email:            c.email ?? '',
      direccion:        c.direccion ?? '',
      tipo_documento:   c.documento?.tipo_documento,
      numero_documento: c.documento?.numero_documento,
      tiene_cuenta:     !!c.usuario,
      id_usuario:       c.usuario?.id_usuario,
    };
  }
}