import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

@Injectable()
export class CreditoBussnies {
  constructor(private readonly repo: CreditoRepository) {}

  metodosPagoPos() {
    return this.repo.metodosConTipo();
  }

  async lineaDe(params: { id_cliente?: number; id_empresa?: number }) {
    if (params.id_empresa) {
      const linea = await this.repo.lineaEmpresa(params.id_empresa);
      if (!linea) {
        throw new NotFoundException(
          cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Empresa no encontrada'),
        );
      }
      return { tipo: 'empresa', id: params.id_empresa, ...linea };
    }
    if (params.id_cliente) {
      const linea = await this.repo.lineaCliente(params.id_cliente);
      if (!linea) {
        throw new NotFoundException(
          cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Cliente no encontrado'),
        );
      }
      return { tipo: 'cliente', id: params.id_cliente, ...linea };
    }
    throw new BadRequestException('Indique id_cliente o id_empresa');
  }

  listar(filtros: any) {
    return this.repo.listar(filtros);
  }

  async obtener(id: number) {
    const cxc = await this.repo.obtener(id);
    if (!cxc) {
      throw new NotFoundException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Cuenta por cobrar no encontrada'),
      );
    }
    return cxc;
  }

  async abonar(
    idCxc: number,
    body: { monto: number; id_metodo?: number; referencia?: string },
    usuario?: UsuarioToken,
  ) {
    this.assertPuedeCobrar(usuario);
    try {
      return await this.repo.registrarAbono({
        id_cxc: idCxc,
        monto: Number(body.monto),
        id_metodo: body.id_metodo,
        referencia: body.referencia,
        id_usuario: usuario?.id_usuario,
      });
    } catch (error: any) {
      const codigo = String(error?.message ?? '');
      if (codigo === 'CxC_NO_ENCONTRADA') {
        throw new NotFoundException(
          cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Cuenta no encontrada'),
        );
      }
      if (codigo === 'CxC_CERRADA') throw new BadRequestException('Esta cuenta ya está cerrada');
      if (codigo === 'CxC_MONTO_INVALIDO') {
        throw new BadRequestException('El abono debe ser mayor a 0 y no superar el saldo');
      }
      throw error;
    }
  }

  async actualizarCliente(id: number, body: any, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    const linea = await this.repo.actualizarLineaCliente(id, body);
    if (!linea) {
      throw new NotFoundException(
        cuerpoError(
          CodigoError.ENTIDAD_NO_ENCONTRADA,
          `No hay cliente con id ${id}. Busca por DNI/nombre en Cuentas por cobrar o créalo primero en Clientes.`,
        ),
      );
    }
    return { tipo: 'cliente', id, ...linea };
  }

  async actualizarEmpresa(id: number, body: any, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    const linea = await this.repo.actualizarLineaEmpresa(id, body);
    if (!linea) {
      throw new NotFoundException(
        cuerpoError(
          CodigoError.ENTIDAD_NO_ENCONTRADA,
          `No hay empresa con id ${id}. Busca por RUC/razón social en Cuentas por cobrar o créala primero en Clientes.`,
        ),
      );
    }
    return { tipo: 'empresa', id, ...linea };
  }

  /** Admin y caja pueden dar crédito / cobrar abonos. */
  assertPuedeDarCredito(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (rol !== 'admin' && rol !== 'caja' && rol !== 'superadmin' && rol !== 'administrador') {
      throw new ForbiddenException(
        cuerpoError(
          CodigoError.CREDITO_SIN_PERMISO,
          'Solo admin o caja pueden registrar ventas a crédito',
        ),
      );
    }
  }

  private assertPuedeCobrar(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (!['admin', 'caja', 'superadmin', 'vendedor', 'administrador'].includes(rol)) {
      throw new ForbiddenException('No tiene permiso para registrar abonos');
    }
  }

  private assertPuedeConfigurar(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (rol !== 'admin' && rol !== 'superadmin' && rol !== 'administrador') {
      throw new ForbiddenException('Solo admin puede configurar límites de crédito');
    }
  }
}
