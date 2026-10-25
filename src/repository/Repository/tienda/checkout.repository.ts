import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetodoEnvio } from '../../../models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from '../../../models/DBModel/tienda/cupon.entity';
import { filasDe } from '../../../caja/bd/resultado-consulta';

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

  /**
   * Suma un uso solo si el cupón no llegó a su tope (UPDATE condicional): dos
   * compras simultáneas no pueden pasarse del límite. TypeORM devuelve
   * `[filas, afectadas]` en un UPDATE, por eso se leen las filas con `filasDe`
   * (contar el resultado crudo daba siempre 2 y el tope nunca frenaba).
   */
  async incrementarUsoCupon(idCupon: number, manager?: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<boolean> {
    const q = manager ?? this.cuponRepo.manager;
    const resultado = await q.query(
      `UPDATE cupones
          SET usos_actuales = COALESCE(usos_actuales, 0) + 1
        WHERE id_cupon = $1
          AND (usos_maximos IS NULL OR COALESCE(usos_actuales, 0) < usos_maximos)
        RETURNING id_cupon`,
      [idCupon],
    );
    return filasDe(resultado).length > 0;
  }
}
