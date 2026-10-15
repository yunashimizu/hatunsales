import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CajaPagosRepository } from '../../repository/Repository/caja-pagos.repository';
import { randomBytes } from 'crypto';
import {
  ActualizarCuentaBancariaRequest,
  CuentaBancariaRequest,
  IniciarYapeRequest,
} from '../../models/model/caja.request';
import { relanzarHttp } from '../../caja/http/errores-caja.http';

@Injectable()
export class CajaPagosBussnies {
  constructor(private readonly repo: CajaPagosRepository) {}

  pasarela() {
    return this.repo.pasarelaPos();
  }

  async listarCuentas(todas = false) {
    try {
      return await this.repo.listarCuentas(!todas);
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async crearCuenta(body: CuentaBancariaRequest) {
    if (!String(body?.banco ?? '').trim()) {
      throw new BadRequestException('El banco es obligatorio');
    }
    try {
      return await this.repo.crearCuenta(body);
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async actualizarCuenta(id: number, body: ActualizarCuentaBancariaRequest) {
    if (body?.banco !== undefined && !String(body.banco).trim()) {
      throw new BadRequestException('El banco no puede quedar vacío');
    }
    let fila: unknown;
    try {
      fila = await this.repo.actualizarCuenta(id, body ?? {});
    } catch (error) {
      relanzarHttp(error);
    }
    if (!fila) throw new NotFoundException('Cuenta no encontrada');
    return fila;
  }

  async eliminarCuenta(id: number) {
    try {
      return await this.repo.eliminarCuenta(id);
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async iniciarYape(body: IniciarYapeRequest) {
    const monto = Number(body?.monto);
    if (!(monto > 0)) throw new BadRequestException('Monto inválido');

    const info = this.repo.pasarelaPos();
    if (!info.culqi_habilitado) {
      return {
        modo: 'manual',
        mensaje:
          'Culqi no está configurado. Registra el N° de operación de Yape manualmente.',
        culqi_habilitado: false,
      };
    }

    try {
      const orden = await this.repo.crearOrdenCulqi({
        monto,
        descripcion: body.descripcion || `Cobro POS Hatunsales S/ ${monto.toFixed(2)}`,
        email: body.email,
        orderNumber: `P${Date.now().toString().slice(-8)}${randomBytes(2).toString('hex')}`.slice(0, 20),
      });
      return {
        modo: 'culqi',
        culqi_habilitado: true,
        ...orden,
        mensaje: 'Orden Yape creada. Pide al cliente pagar y luego verifica.',
      };
    } catch (error: any) {
      if (String(error?.message) === 'CULQI_NO_CONFIG') {
        return {
          modo: 'manual',
          culqi_habilitado: false,
          mensaje: 'Culqi no está configurado. Usa referencia manual.',
        };
      }
      throw new BadRequestException(error?.message || 'No se pudo iniciar Yape');
    }
  }

  async verificarYape(orderId: string) {
    const id = String(orderId ?? '').trim();
    if (!id) throw new BadRequestException('order_id requerido');
    if (id.length > 80) throw new BadRequestException('order_id inválido');
    try {
      const estado = await this.repo.consultarOrdenCulqi(id);
      return {
        ...estado,
        validacion: estado.pagado ? 'culqi' : 'pendiente',
        mensaje: estado.pagado
          ? 'Pago Yape confirmado. Ya puedes cobrar la venta.'
          : 'Aún no figura como pagado. Espera unos segundos y vuelve a verificar.',
      };
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'No se pudo verificar Yape');
    }
  }
}
