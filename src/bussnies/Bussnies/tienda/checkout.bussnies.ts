import { BadRequestException, Injectable } from '@nestjs/common';
import { CheckoutRepository } from '../../../repository/Repository/tienda/checkout.repository';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';

export interface CuponAplicado {
  cupon: Cupon;
  descuento: number;
}

@Injectable()
export class CheckoutBussnies {

  constructor(private readonly repo: CheckoutRepository) {}

  async metodosEnvio() {
    const lista = await this.repo.listarMetodosEnvio();
    return lista.map((m) => ({
      id_metodo_envio: m.id_metodo_envio,
      nombre: m.nombre,
      descripcion: m.descripcion ?? '',
      costo: Number(m.costo ?? 0),
      dias_min: Number(m.dias_min ?? 0),
      dias_max: Number(m.dias_max ?? 0),
    }));
  }

  async metodosPago() {
    const lista = await this.repo.listarMetodosPago();
    return lista.map((m) => ({
      id_metodo: m.id_metodo,
      nombre: m.nombre,
      tipo: m.tipo ?? 'otro',
      descripcion: m.descripcion ?? '',
      logo_url: m.logo_url ?? null,
    }));
  }

  async costoEnvio(idMetodoEnvio?: number): Promise<number> {
    if (!idMetodoEnvio) return 0;
    const metodo = await this.repo.obtenerMetodoEnvio(idMetodoEnvio);
    if (!metodo) throw new BadRequestException('El método de envío seleccionado no existe');
    return Number(metodo.costo ?? 0);
  }

  /**
   * Valida un cupón contra el monto de la compra y devuelve el descuento en soles.
   * Lanza excepción con un mensaje claro cuando no aplica.
   */
  async validarCupon(codigo: string, montoCompra: number): Promise<CuponAplicado> {
    const cupon = await this.repo.buscarCupon(codigo.trim());
    if (!cupon) throw new BadRequestException('El cupón no existe');
    if (cupon.activo === false) throw new BadRequestException('El cupón ya no está activo');

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    if (cupon.fecha_inicio && new Date(cupon.fecha_inicio) > hoy) {
      throw new BadRequestException('El cupón todavía no está vigente');
    }

    if (cupon.fecha_fin && new Date(cupon.fecha_fin) < hoy) {
      throw new BadRequestException('El cupón ya venció');
    }

    if (cupon.usos_maximos && Number(cupon.usos_actuales ?? 0) >= Number(cupon.usos_maximos)) {
      throw new BadRequestException('El cupón alcanzó su límite de usos');
    }

    const minimo = Number(cupon.minimo_compra ?? 0);
    if (minimo > 0 && montoCompra < minimo) {
      throw new BadRequestException(`El cupón aplica en compras desde S/ ${minimo.toFixed(2)}`);
    }

    const valor = Number(cupon.valor ?? 0);
    const descuentoBruto = cupon.tipo === 'monto' ? valor : (montoCompra * valor) / 100;
    const descuento = Math.round(Math.min(descuentoBruto, montoCompra) * 100) / 100;

    return { cupon, descuento };
  }

  async registrarUso(idCupon: number, manager?: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<void> {
    const ok = await this.repo.incrementarUsoCupon(idCupon, manager);
    if (!ok) throw new BadRequestException('El cupón alcanzó su límite de usos');
  }
}
