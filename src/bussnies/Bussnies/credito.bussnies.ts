import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Injectable()
export class CreditoBussnies {
  constructor(private readonly repo: CreditoRepository) {}

  metodosPagoPos() {
    return this.repo.metodosConTipo();
  }

  async lineaDe(params: { id_cliente?: number; id_empresa?: number }) {
    if (params.id_empresa) {
      const linea = await this.repo.lineaEmpresa(params.id_empresa);
      if (!linea) throw new NotFoundException('Empresa no encontrada');
      return { tipo: 'empresa', id: params.id_empresa, ...linea };
    }
    if (params.id_cliente) {
      const linea = await this.repo.lineaCliente(params.id_cliente);
      if (!linea) throw new NotFoundException('Cliente no encontrado');
      return { tipo: 'cliente', id: params.id_cliente, ...linea };
    }
    throw new BadRequestException('Indique id_cliente o id_empresa');
  }

  listar(filtros: any) {
    return this.repo.listar(filtros);
  }

  async obtener(id: number) {
    const cxc = await this.repo.obtener(id);
    if (!cxc) throw new NotFoundException('Cuenta por cobrar no encontrada');
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
      if (codigo === 'CxC_NO_ENCONTRADA') throw new NotFoundException('Cuenta no encontrada');
      if (codigo === 'CxC_CERRADA') throw new BadRequestException('Esta cuenta ya está cerrada');
      if (codigo === 'CxC_MONTO_INVALIDO') {
        throw new BadRequestException('El abono debe ser mayor a 0 y no superar el saldo');
      }
      throw error;
    }
  }

  actualizarCliente(id: number, body: any, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    return this.repo.actualizarLineaCliente(id, body);
  }

  actualizarEmpresa(id: number, body: any, usuario?: UsuarioToken) {
    this.assertPuedeConfigurar(usuario);
    return this.repo.actualizarLineaEmpresa(id, body);
  }

  /** Admin y caja pueden dar crédito / cobrar abonos. */
  assertPuedeDarCredito(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (rol !== 'admin' && rol !== 'caja' && rol !== 'superadmin') {
      throw new ForbiddenException('Solo admin o caja pueden registrar ventas a crédito');
    }
  }

  private assertPuedeCobrar(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (!['admin', 'caja', 'superadmin', 'vendedor'].includes(rol)) {
      throw new ForbiddenException('No tiene permiso para registrar abonos');
    }
  }

  private assertPuedeConfigurar(usuario?: UsuarioToken) {
    const rol = (usuario?.rol ?? '').toLowerCase();
    if (rol !== 'admin' && rol !== 'superadmin') {
      throw new ForbiddenException('Solo admin puede configurar límites de crédito');
    }
  }
}
