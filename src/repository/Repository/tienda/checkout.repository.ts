import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetodoEnvio } from '../../../models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';

/** Catálogos auxiliares del checkout: envíos, pagos y cupones. */
@Injectable()
export class CheckoutRepository {

  constructor(
    @InjectRepository(MetodoEnvio, 'pgConnection')
    private readonly envioRepo: Repository<MetodoEnvio>,

    @InjectRepository(MetodoPago, 'pgConnection')
    private readonly pagoRepo: Repository<MetodoPago>,

    @InjectRepository(Cupon, 'pgConnection')
    private readonly cuponRepo: Repository<Cupon>,
  ) {}

  async listarMetodosEnvio(): Promise<MetodoEnvio[]> {
    return this.envioRepo.find({
      where: { activo: true },
      order: { orden: 'ASC', id_metodo_envio: 'ASC' },
    });
  }

  async obtenerMetodoEnvio(id: number): Promise<MetodoEnvio | null> {
    return this.envioRepo.findOne({ where: { id_metodo_envio: id } });
  }

  async listarMetodosPago(): Promise<MetodoPago[]> {
    return this.pagoRepo.find({
      where: { activo: true },
      order: { orden: 'ASC', id_metodo: 'ASC' },
    });
  }

  async obtenerMetodoPago(id: number): Promise<MetodoPago | null> {
    return this.pagoRepo.findOne({ where: { id_metodo: id } });
  }

  async buscarCupon(codigo: string): Promise<Cupon | null> {
    return this.cuponRepo
      .createQueryBuilder('c')
      .where('UPPER(c.codigo) = UPPER(:codigo)', { codigo })
      .getOne();
  }

  async incrementarUsoCupon(idCupon: number): Promise<void> {
    await this.cuponRepo.increment({ id_cupon: idCupon }, 'usos_actuales', 1);
  }
}
