import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ResultadoPingBd } from '../../models/model/salud.response';
import type { ISaludRepository } from '../Irepository/ISaludRepository';

@Injectable()
export class SaludRepository implements ISaludRepository {
  constructor(@InjectDataSource('pgConnection') private readonly dataSource: DataSource) {}

  async ping(tiempoMaximoMs: number): Promise<ResultadoPingBd> {
    const inicio = performance.now();
    const medir = () => Math.round(performance.now() - inicio);
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const consulta = this.dataSource.query('SELECT 1').then(() => 'ok' as const);
    consulta.catch(() => undefined); // si gana el timeout, el rechazo tardío no queda sin manejar
    const limite = new Promise<'timeout'>((resolver) => {
      temporizador = setTimeout(() => resolver('timeout'), tiempoMaximoMs);
      temporizador.unref?.();
    });

    try {
      const estado = await Promise.race([consulta, limite]);
      return { estado, ms: medir() };
    } catch {
      return { estado: 'error', ms: medir() };
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }
}
