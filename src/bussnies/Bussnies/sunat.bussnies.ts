import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { SunatRepository } from '../../repository/Repository/sunat.repository';
import { sunatConfig } from '../../config/sunat.config';
import { BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest } from '../../models/model/sunat.request';
import { DniResponse, RucResponse } from '../../models/model/sunat.response';
import { ISunatBussniees } from '../Ibussnies/ISunatBussniees';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';
import { Proveedor } from '../../models/DBModel/proveedor.entity';

@Injectable()
export class SunatBussnies implements ISunatBussniees {

  constructor(private readonly sunatRepo: SunatRepository) {}

  // ── DNI solo consulta ────────────────────────────────────────

  async consultarDni(dni: string): Promise<DniResponse> {
    if (dni.length !== 8) throw new BadRequestException('El DNI debe tener 8 dígitos');

    const enBD = await this.sunatRepo.buscarClientePorDni(Number(dni));
    if (enBD) return this.mapCliente(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.dniUrl}/${dni}?token=${sunatConfig.token}`
      );

      if (!data?.success) throw new BadRequestException('DNI no encontrado en SUNAT');

      return {
        success: true,
        dni,
        nombre: data.nombres,
        apellido_paterno: data.apellidoPaterno,
        apellido_materno: data.apellidoMaterno,
        nombre_completo: `${data.nombres} ${data.apellidoPaterno} ${data.apellidoMaterno}`,
        tipo_documento: 'DNI',
        numero_documento: Number(dni),
        guardado: false,
      };

    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Error al conectar con SUNAT');
    }
  }

  // ── DNI consulta y guarda en clientes + documento ────────────

  async guardarClienteDni(dto: BuscarDniRequest): Promise<DniResponse> {
    if (dto.dni.length !== 8) throw new BadRequestException('El DNI debe tener 8 dígitos');

    const enBD = await this.sunatRepo.buscarClientePorDni(Number(dto.dni));
    if (enBD) return this.mapCliente(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.dniUrl}/${dto.dni}?token=${sunatConfig.token}`
      );

      if (!data?.success) throw new BadRequestException('DNI no encontrado en SUNAT');

      const guardado = await this.sunatRepo.guardarCliente({
        nombre:           data.nombres,
        apellido_paterno: data.apellidoPaterno,
        apellido_materno: data.apellidoMaterno,
        dni:              Number(dto.dni),
        telefono:         dto.telefono,
        email:            dto.email,
        direccion:        dto.direccion,
      });

      return this.mapCliente(guardado);

    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Error al conectar con SUNAT');
    }
  }

  // ── RUC solo consulta ────────────────────────────────────────

  async consultarRuc(ruc: string): Promise<RucResponse> {
    if (ruc.length !== 11) throw new BadRequestException('El RUC debe tener 11 dígitos');

    const enBD = await this.sunatRepo.buscarEmpresaPorRuc(ruc);
    if (enBD) return this.mapEmpresa(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.rucUrl}/${ruc}?token=${sunatConfig.token}`
      );

      if (!data?.razonSocial) throw new BadRequestException('RUC no encontrado en SUNAT');

      return {
        success:          true,
        ruc:              data.ruc,
        nombre:           data.razonSocial ?? '',
        nombre_comercial: data.nombreComercial ?? null,
        telefono:         Array.isArray(data.telefonos) ? data.telefonos.join(',') : '',
        email:            '',
        direccion:        data.direccion ?? '',
        departamento:     data.departamento ?? '',
        provincia:        data.provincia ?? '',
        distrito:         data.distrito ?? '',
        ubigeo:           data.ubigeo ?? '',
        capital:          data.capital ?? '',
        estado:           data.estado ?? '',
        condicion:        data.condicion ?? '',
        tipo:             data.tipo ?? null,
        fecha_inscripcion: data.fechaInscripcion ?? null,
        fecha_baja:       data.fechaBaja ?? null,
        guardado:         false,
      };

    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Error al conectar con SUNAT');
    }
  }

  // ── RUC guarda en empresas ───────────────────────────────────

  async guardarEmpresaRuc(dto: BuscarRucEmpresaRequest): Promise<RucResponse> {
    if (dto.ruc.length !== 11) throw new BadRequestException('El RUC debe tener 11 dígitos');

    const enBD = await this.sunatRepo.buscarEmpresaPorRuc(dto.ruc);
    if (enBD) return this.mapEmpresa(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.rucUrl}/${dto.ruc}?token=${sunatConfig.token}`
      );

      if (!data?.razonSocial) throw new BadRequestException('RUC no encontrado en SUNAT');

      const guardada = await this.sunatRepo.guardarEmpresa({
        ruc:              dto.ruc,
        razon_social:     data.razonSocial ?? '',          // ← razon_social
        nombre_comercial: data.nombreComercial ?? '',
        telefonos:        Array.isArray(data.telefonos)    // ← telefonos
                            ? data.telefonos.join(',')
                            : (data.telefonos ?? ''),
        direccion:        data.direccion ?? '',
        departamento:     data.departamento ?? '',
        provincia:        data.provincia ?? '',
        distrito:         data.distrito ?? '',
        ubigeo:           data.ubigeo ?? '',
        capital:          data.capital ?? '',
        estado:           data.estado ?? '',
        condicion:        data.condicion ?? '',
        tipo:             data.tipo ?? '',
        fecha_inscripcion: data.fechaInscripcion ?? '',
        fecha_baja:       data.fechaBaja ?? '',
      });

      return this.mapEmpresa(guardada);

    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Error al conectar con SUNAT');
    }
  }

  // ── RUC guarda en proveedores ────────────────────────────────

  async guardarProveedorRuc(dto: BuscarRucProveedorRequest): Promise<RucResponse> {
    if (dto.ruc.length !== 11) throw new BadRequestException('El RUC debe tener 11 dígitos');

    const enBD = await this.sunatRepo.buscarProveedorPorRuc(dto.ruc);
    if (enBD) return this.mapProveedor(enBD);

    try {
      const { data } = await axios.get(
        `${sunatConfig.rucUrl}/${dto.ruc}?token=${sunatConfig.token}`
      );

      if (!data?.razonSocial) throw new BadRequestException('RUC no encontrado en SUNAT');

      const guardado = await this.sunatRepo.guardarProveedor({
        ruc:      dto.ruc,
        nombre:   data.razonSocial ?? '',
        telefono: dto.telefono ?? (Array.isArray(data.telefonos) ? data.telefonos[0] : ''),
        email:    dto.email ?? '',
        direccion: dto.direccion ?? data.direccion ?? '',
      });

      return this.mapProveedor(guardado);

    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Error al conectar con SUNAT');
    }
  }

  // ── Mappers privados ─────────────────────────────────────────

  private mapCliente(c: Cliente): DniResponse {
    return {
      success:          true,
      id_cliente:       c.id_cliente,
      id_documento:     c.documento?.id_documento,
      dni:              String(c.dni),
      nombre:           c.nombre,
      apellido_paterno: c.apellido_paterno,
      apellido_materno: c.apellido_materno,
      nombre_completo:  `${c.nombre} ${c.apellido_paterno} ${c.apellido_materno}`,
      tipo_documento:   c.documento?.tipo_documento ?? 'DNI',
      numero_documento: c.documento?.numero_documento ?? c.dni,
      guardado:         true,
    };
  }

  private mapEmpresa(e: Empresa): RucResponse {
    return {
      success:          true,
      id_empresa:       e.id_empresa,
      ruc:              e.ruc,
      nombre:           e.razon_social,        // ← razon_social en entidad
      nombre_comercial: e.nombre_comercial,
      telefono:         e.telefonos,           // ← telefonos en entidad
      email:            '',                    // ← no existe en entidad
      direccion:        e.direccion,
      departamento:     e.departamento ?? '',
      provincia:        e.provincia ?? '',
      distrito:         e.distrito ?? '',
      ubigeo:           e.ubigeo,
      capital:          e.capital,
      estado:           e.estado ?? '',
      condicion:        e.condicion ?? '',
      tipo:             e.tipo,
      fecha_inscripcion: e.fecha_inscripcion,
      fecha_baja:       e.fecha_baja,
      guardado:         true,
    };
  }

  private mapProveedor(p: Proveedor): RucResponse {
    return {
      success:          true,
      id_proveedor:     p.id_proveedor,
      ruc:              p.ruc,
      nombre:           p.nombre,
      nombre_comercial: null,
      telefono:         p.telefono,
      email:            p.email,
      direccion:        p.direccion,
      departamento:     '',
      provincia:        '',
      distrito:         '',
      ubigeo:           '',
      capital:          '',
      estado:           '',
      condicion:        '',
      tipo:             null,
      fecha_inscripcion: null,
      fecha_baja:       null,
      guardado:         true,
    };
  }
}