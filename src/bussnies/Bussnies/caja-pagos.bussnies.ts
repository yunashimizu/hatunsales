import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CajaPagosRepository } from '../../repository/Repository/caja-pagos.repository';
import { randomBytes } from 'crypto';

@Injectable()
export class CajaPagosBussnies {
  constructor(private readonly repo: CajaPagosRepository) {}

  pasarela() {
    return this.repo.pasarelaPos();
  }

  listarCuentas(todas = false) {
    return this.repo.listarCuentas(!todas);
  }

  async crearCuenta(body: any) {
    if (!String(body?.banco ?? '').trim()) {
      throw new BadRequestException('El banco es obligatorio');
    }
    return this.repo.crearCuenta(body);
  }

  async actualizarCuenta(id: number, body: any) {
    const fila = await this.repo.actualizarCuenta(id, body);
    if (!fila) throw new NotFoundException('Cuenta no encontrada');
    return fila;
  }

  eliminarCuenta(id: number) {
    return this.repo.eliminarCuenta(id);
  }

  async iniciarYape(body: { monto: number; email?: string; descripcion?: string }) {
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
    if (!orderId?.trim()) throw new BadRequestException('order_id requerido');
    try {
      const estado = await this.repo.consultarOrdenCulqi(orderId.trim());
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
