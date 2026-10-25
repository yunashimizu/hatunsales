import { BadRequestException, Injectable } from '@nestjs/common';
import { CheckoutRepository } from '../../../repository/Repository/tienda/checkout.repository';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';
import { hoyLima } from '../../../util/fecha-lima';

export interface CuponAplicado {
  cupon: Cupon;
  descuento: number;
}

function dos(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 'YYYY-MM-DD' de una columna `date`. TypeORM la entrega como texto; si llegara
 * como Date (medianoche local del proceso) se leen sus partes locales, igual
 * que hace TypeORM al convertirla.
 */
function diaDe(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return `${valor.getFullYear()}-${dos(valor.getMonth() + 1)}-${dos(valor.getDate())}`;
  }
  const texto = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
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

  /** Costo del envío elegido; solo vale un método que la tienda ofrece (activo). */
  async costoEnvio(idMetodoEnvio?: number): Promise<number> {
    if (!idMetodoEnvio) return 0;
    const metodo = await this.repo.obtenerMetodoEnvio(idMetodoEnvio);
    if (!metodo || metodo.activo === false) {
      throw new BadRequestException('El método de envío seleccionado no está disponible. Elige otro.');
    }
    return Number(metodo.costo ?? 0);
  }

  /** El pedido solo puede llevar un método de pago que la tienda ofrece (activo). */
  async validarMetodoPago(idMetodo: number): Promise<void> {
    const metodo = await this.repo.obtenerMetodoPago(idMetodo);
    if (!metodo || metodo.activo === false) {
      throw new BadRequestException('El método de pago seleccionado no está disponible. Elige otro.');
    }
  }

  /**
   * Valida un cupón contra el monto de la compra y devuelve el descuento en soles.
   * Lanza excepción con un mensaje claro cuando no aplica.
   */
  async validarCupon(codigo: string, montoCompra: number): Promise<CuponAplicado> {
    const limpio = typeof codigo === 'string' ? codigo.trim() : '';
    if (!limpio) throw new BadRequestException('Escribe el código del cupón');

    const cupon = await this.repo.buscarCupon(limpio);
    if (!cupon) throw new BadRequestException('El cupón no existe');
    if (cupon.activo === false) throw new BadRequestException('El cupón ya no está activo');

    // Vigencia por día de Lima: con el servidor en UTC, un cupón que vence hoy
    // dejaba de valer a las 19:00 y uno que empieza mañana ya valía esta noche.
    const hoy = hoyLima();
    const inicio = diaDe(cupon.fecha_inicio);
    const fin = diaDe(cupon.fecha_fin);

    if (inicio && inicio > hoy) {
      throw new BadRequestException('El cupón todavía no está vigente');
    }

    if (fin && fin < hoy) {
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
