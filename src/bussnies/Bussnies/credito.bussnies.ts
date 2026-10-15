import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditoRepository, ESTADOS_CXC } from '../../repository/Repository/credito.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { AbonoCreditoRequest, LineaCreditoRequest } from '../../models/model/credito.request';
import { relanzarHttp } from '../../caja/http/errores-caja.http';
import { categoriaMetodo } from '../../caja/dominio/metodo-pago';
import { CodigoErrorCaja, cuerpoErrorCaja } from '../../caja/dominio/errores-caja';

@Injectable()
export class CreditoBussnies {
  constructor(private readonly repo: CreditoRepository) {}

  metodosPagoPos() {
    return this.repo.metodosConTipo();
  }

  async lineaDe(params: { id_cliente?: number; id_empresa?: number }) {
    try {
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
    } catch (error) {
      relanzarHttp(error);
    }
    throw new BadRequestException('Indique id_cliente o id_empresa');
  }

  async listar(filtros: { estado?: string; texto?: string; pagina?: number; limite?: number }) {
    const estado = String(filtros.estado ?? '').trim().toLowerCase();
    if (estado && !(ESTADOS_CXC as readonly string[]).includes(estado)) {
      throw new BadRequestException(`Estado inválido. Use: ${ESTADOS_CXC.join(', ')}.`);
    }
    try {
      return await this.repo.listar({ ...filtros, estado: estado || undefined });
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async obtener(id: number) {
    let cxc: unknown;
    try {
      cxc = await this.repo.obtener(id);
    } catch (error) {
      relanzarHttp(error);
    }
    if (!cxc) {
      throw new NotFoundException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Cuenta por cobrar no encontrada'),
      );
    }
    return cxc;
  }

  async abonar(idCxc: number, body: AbonoCreditoRequest, usuario?: UsuarioToken) {
    this.assertPuedeCobrar(usuario);
    if (body.id_metodo != null) await this.validarMedioAbono(Number(body.id_metodo));
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
      relanzarHttp(error);
    }
  }

  async actualizarCliente(id: number, body: LineaCreditoRequest, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    let linea: unknown;
    try {
      linea = await this.repo.actualizarLineaCliente(id, body ?? {});
    } catch (error) {
      relanzarHttp(error);
    }
    if (!linea) {
      throw new NotFoundException(
        cuerpoError(
          CodigoError.ENTIDAD_NO_ENCONTRADA,
          `No hay cliente con id ${id}. Busca por DNI/nombre en Cuentas por cobrar o créalo primero en Clientes.`,
        ),
      );
    }
    return { tipo: 'cliente', id, ...(linea as object) };
  }

  async actualizarEmpresa(id: number, body: LineaCreditoRequest, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    let linea: unknown;
    try {
      linea = await this.repo.actualizarLineaEmpresa(id, body ?? {});
    } catch (error) {
      relanzarHttp(error);
    }
    if (!linea) {
      throw new NotFoundException(
        cuerpoError(
          CodigoError.ENTIDAD_NO_ENCONTRADA,
          `No hay empresa con id ${id}. Busca por RUC/razón social en Cuentas por cobrar o créala primero en Clientes.`,
        ),
      );
    }
    return { tipo: 'empresa', id, ...(linea as object) };
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

  /** El abono debe hacerse con un medio activo y que sea dinero (no "Crédito"). */
  private async validarMedioAbono(idMetodo: number): Promise<void> {
    const metodo = (await this.repo.metodosConTipo()).find((m) => m.id_metodo === idMetodo);
    if (!metodo) {
      throw new BadRequestException(
        cuerpoErrorCaja(CodigoErrorCaja.VENTA_PAGO_INVALIDO, 'El medio de pago del abono no existe o está inactivo.'),
      );
    }
    if (categoriaMetodo(metodo.tipo, metodo.nombre) === 'credito') {
      throw new BadRequestException(
        cuerpoErrorCaja(
          CodigoErrorCaja.VENTA_PAGO_INVALIDO,
          'Elija cómo pagó el cliente (efectivo, Yape, transferencia…): «Crédito» no sirve para abonar.',
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
