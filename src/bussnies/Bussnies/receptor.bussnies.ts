import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ReceptorRepository } from '../../repository/Repository/receptor.repository';
import { ConsultaDocumentoService } from '../../util/sunat/consulta-documento.service';
import { ReceptorResponse, SugerenciaReceptor } from '../../models/model/receptor.response';
import { TIPO_DOC_DNI, TIPO_DOC_RUC } from '../../util/fiscal/nubefact.catalogo';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Empresa } from '../../models/DBModel/empresa.entity';

/**
 * Resuelve quién recibe un comprobante.
 *
 * El flujo es siempre el mismo: se busca el documento en la base local y solo
 * si no está se consulta el servicio externo, guardando el resultado para que
 * la siguiente venta a esa persona ya no dependa de internet.
 */

/** Tope que fija SUNAT para emitir boleta sin identificar al comprador. */
export const TOPE_BOLETA_SIN_DOCUMENTO = 700;

const CONSUMIDOR_FINAL: ReceptorResponse = {
  origen: 'generico',
  tipo: 'cliente',
  tipo_documento: TIPO_DOC_DNI,
  numero_documento: '00000000',
  denominacion: 'CLIENTES VARIOS',
  direccion: '',
  email: '',
  telefono: '',
  admite_factura: false,
};

@Injectable()
export class ReceptorBussnies {

  constructor(
    private readonly repo: ReceptorRepository,
    private readonly consulta: ConsultaDocumentoService,
  ) {}

  consumidorFinal(): ReceptorResponse {
    return { ...CONSUMIDOR_FINAL };
  }

  /**
   * Busca un documento de 8 u 11 dígitos. Cuando `guardar` es verdadero, lo que
   * venga del servicio externo queda registrado en `clientes` o en `empresas`.
   */
  async buscarPorDocumento(documento: string, guardar = true): Promise<ReceptorResponse> {
    const numero = this.limpiar(documento);

    if (numero.length === 8) return this.buscarPersona(numero, guardar);
    if (numero.length === 11) return this.buscarEmpresa(numero, guardar);

    throw new BadRequestException('El documento debe tener 8 dígitos si es DNI u 11 si es RUC');
  }

  async buscarPersona(dni: string, guardar = true): Promise<ReceptorResponse> {
    const enBase = await this.repo.buscarClientePorDni(Number(dni));
    if (enBase) return this.desdeCliente(enBase, 'base');

    try {
      const datos = await this.consulta.consultarDni(dni);
      if (!datos) throw new NotFoundException(`No se encontró ninguna persona con el DNI ${dni}`);

      if (!guardar) {
        return {
          origen: 'externo',
          tipo: 'cliente',
          tipo_documento: TIPO_DOC_DNI,
          numero_documento: dni,
          denominacion: datos.nombre_completo,
          direccion: '',
          email: '',
          telefono: '',
          admite_factura: false,
        };
      }

      const cliente = await this.repo.guardarCliente({
        dni: Number(dni),
        nombre: datos.nombres,
        apellido_paterno: datos.apellido_paterno,
        apellido_materno: datos.apellido_materno,
      });

      return this.desdeCliente(cliente, 'externo');
    } catch (error) {
      // Sin token o sin red: se deja un borrador para completar a mano en el POS.
      if (error instanceof ServiceUnavailableException) {
        return this.borradorPersona(dni, this.textoDeExcepcion(error));
      }
      throw error;
    }
  }

  async buscarEmpresa(ruc: string, guardar = true): Promise<ReceptorResponse> {
    const enBase = await this.repo.buscarEmpresaPorRuc(ruc);
    if (enBase) return this.desdeEmpresa(enBase, 'base');

    try {
      const datos = await this.consulta.consultarRuc(ruc);
      if (!datos) throw new NotFoundException(`No se encontró ninguna empresa con el RUC ${ruc}`);

      if (!guardar) {
        return {
          origen: 'externo',
          tipo: 'empresa',
          tipo_documento: TIPO_DOC_RUC,
          numero_documento: ruc,
          denominacion: datos.razon_social,
          nombre_comercial: datos.nombre_comercial,
          direccion: datos.direccion,
          email: '',
          telefono: datos.telefonos,
          estado: datos.estado,
          condicion: datos.condicion,
          ...this.evaluarRuc(datos.estado, datos.condicion),
        };
      }

      const empresa = await this.repo.guardarEmpresa({
        ruc,
        razon_social: datos.razon_social,
        nombre_comercial: datos.nombre_comercial,
        telefonos: datos.telefonos,
        tipo: datos.tipo,
        estado: datos.estado,
        condicion: datos.condicion,
        direccion: datos.direccion,
        departamento: datos.departamento,
        provincia: datos.provincia,
        distrito: datos.distrito,
        ubigeo: datos.ubigeo,
        capital: datos.capital,
        fecha_inscripcion: datos.fecha_inscripcion,
        fecha_baja: datos.fecha_baja,
      });

      return this.desdeEmpresa(empresa, 'externo');
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        return this.borradorEmpresa(ruc, this.textoDeExcepcion(error));
      }
      throw error;
    }
  }

  private textoDeExcepcion(error: ServiceUnavailableException): string {
    const respuesta = error.getResponse();
    if (typeof respuesta === 'string') return respuesta;
    if (respuesta && typeof respuesta === 'object' && 'message' in respuesta) {
      const mensaje = (respuesta as { message?: string | string[] }).message;
      if (Array.isArray(mensaje)) return mensaje.join('. ');
      if (typeof mensaje === 'string') return mensaje;
    }
    return 'La consulta automática de documentos no está disponible. Complete los datos a mano.';
  }

  /** Plantilla editable cuando SUNAT no responde o no está configurado. */
  private borradorPersona(dni: string, motivo: string): ReceptorResponse {
    return {
      origen: 'externo',
      tipo: 'cliente',
      tipo_documento: TIPO_DOC_DNI,
      numero_documento: dni,
      denominacion: '',
      direccion: '',
      email: '',
      telefono: '',
      admite_factura: false,
      advertencia: motivo,
    };
  }

  private borradorEmpresa(ruc: string, motivo: string): ReceptorResponse {
    return {
      origen: 'externo',
      tipo: 'empresa',
      tipo_documento: TIPO_DOC_RUC,
      numero_documento: ruc,
      denominacion: '',
      nombre_comercial: '',
      direccion: '',
      email: '',
      telefono: '',
      admite_factura: true,
      advertencia: motivo,
    };
  }

  /** Alta o actualización con los datos que escribió el cajero a mano. */
  async registrarManual(
    documento: string,
    datos: { denominacion: string; direccion?: string; email?: string; telefono?: string },
  ): Promise<ReceptorResponse> {
    const numero = this.limpiar(documento);
    const nombre = (datos.denominacion ?? '').trim();
    if (!nombre) throw new BadRequestException('Indique el nombre o razón social');

    if (numero.length === 8) {
      const partes = nombre.split(/\s+/);
      const cliente = await this.repo.guardarCliente({
        dni: Number(numero),
        nombre: partes[0] ?? nombre,
        apellido_paterno: partes[1] ?? '',
        apellido_materno: partes.slice(2).join(' '),
        direccion: datos.direccion ?? '',
        email: datos.email ?? '',
        telefono: datos.telefono ?? '',
      });
      return this.desdeCliente(cliente, 'base');
    }

    if (numero.length === 11) {
      const empresa = await this.repo.guardarEmpresa({
        ruc: numero,
        razon_social: nombre,
        direccion: datos.direccion ?? '',
        telefonos: datos.telefono ?? '',
      });
      return this.desdeEmpresa(empresa, 'base');
    }

    throw new BadRequestException('El documento debe tener 8 dígitos si es DNI u 11 si es RUC');
  }

  async porIdCliente(id_cliente: number): Promise<ReceptorResponse> {
    const cliente = await this.repo.buscarClientePorId(id_cliente);
    if (!cliente) throw new NotFoundException(`No existe el cliente ${id_cliente}`);
    return this.desdeCliente(cliente, 'base');
  }

  async porIdEmpresa(id_empresa: number): Promise<ReceptorResponse> {
    const empresa = await this.repo.buscarEmpresaPorId(id_empresa);
    if (!empresa) throw new NotFoundException(`No existe la empresa ${id_empresa}`);
    return this.desdeEmpresa(empresa, 'base');
  }

  /** Sugerencias para el autocompletado del punto de venta. */
  async autocompletar(termino: string, limite = 8): Promise<SugerenciaReceptor[]> {
    const texto = (termino ?? '').trim();
    if (texto.length < 2) return [];

    const [clientes, empresas] = await Promise.all([
      this.repo.sugerirClientes(texto, limite),
      this.repo.sugerirEmpresas(texto, limite),
    ]);

    const sugerencias: SugerenciaReceptor[] = [
      ...empresas.map((e) => ({
        tipo: 'empresa' as const,
        id_empresa: e.id_empresa,
        tipo_documento: TIPO_DOC_RUC,
        numero_documento: e.ruc,
        denominacion: e.razon_social ?? e.nombre_comercial ?? e.ruc,
      })),
      ...clientes.map((c) => ({
        tipo: 'cliente' as const,
        id_cliente: c.id_cliente,
        tipo_documento: TIPO_DOC_DNI,
        numero_documento: c.dni ? String(c.dni) : '',
        denominacion: this.nombreCompleto(c),
      })),
    ];

    return sugerencias.slice(0, limite);
  }

  // ── Conversión a la forma común ──────────────────────────────

  private desdeCliente(cliente: Cliente, origen: 'base' | 'externo'): ReceptorResponse {
    return {
      origen,
      tipo: 'cliente',
      id_cliente: cliente.id_cliente,
      tipo_documento: TIPO_DOC_DNI,
      numero_documento: cliente.dni ? String(cliente.dni).padStart(8, '0') : '',
      denominacion: this.nombreCompleto(cliente),
      direccion: cliente.direccion ?? '',
      email: cliente.email ?? '',
      telefono: cliente.telefono ?? '',
      admite_factura: false,
    };
  }

  private desdeEmpresa(empresa: Empresa, origen: 'base' | 'externo'): ReceptorResponse {
    return {
      origen,
      tipo: 'empresa',
      id_empresa: empresa.id_empresa,
      tipo_documento: TIPO_DOC_RUC,
      numero_documento: empresa.ruc,
      denominacion: empresa.razon_social ?? empresa.nombre_comercial ?? empresa.ruc,
      nombre_comercial: empresa.nombre_comercial ?? '',
      direccion: empresa.direccion ?? '',
      email: '',
      telefono: empresa.telefonos ?? '',
      estado: empresa.estado ?? '',
      condicion: empresa.condicion ?? '',
      ...this.evaluarRuc(empresa.estado, empresa.condicion),
    };
  }

  /**
   * Un RUC de baja o no habido sigue permitiendo emitir, pero conviene avisarlo
   * en pantalla porque suele terminar en observación por parte de SUNAT.
   */
  private evaluarRuc(estado?: string, condicion?: string): { admite_factura: boolean; advertencia?: string } {
    const activo = !estado || estado.toUpperCase().includes('ACTIVO');
    const noHabido = Boolean(condicion) && condicion!.toUpperCase().includes('NO HABIDO');
    const habido = !noHabido;

    if (!activo) return { admite_factura: true, advertencia: `El RUC figura como ${estado} en SUNAT` };
    if (!habido) return { admite_factura: true, advertencia: `El RUC figura como ${condicion} en SUNAT` };
    return { admite_factura: true };
  }

  private nombreCompleto(cliente: Cliente): string {
    return [cliente.nombre, cliente.apellido_paterno, cliente.apellido_materno]
      .filter(Boolean)
      .join(' ')
      .trim() || `Cliente ${cliente.id_cliente}`;
  }

  private limpiar(documento: string): string {
    return (documento ?? '').toString().replace(/\D/g, '');
  }
}
