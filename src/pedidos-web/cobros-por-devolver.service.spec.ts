import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CobrosPorDevolverService } from './cobros-por-devolver.service';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function armar(opciones: { correo?: string | null; filas?: any[]; enviadorFalla?: boolean } = {}) {
  const dataSource = { query: jest.fn(async (): Promise<any> => opciones.filas ?? []) };
  const config = { obtener: jest.fn(async (clave: string) => (clave === 'fiscal_alertas_correo' ? opciones.correo ?? null : null)) };
  const enviador = {
    nombre: 'archivo',
    enviar: jest.fn(async () => {
      if (opciones.enviadorFalla) throw new Error('sin red');
      return { id_mensaje: '1' };
    }),
  };
  const bitacora = { registrarCon: jest.fn(async () => undefined) };
  const servicio = new CobrosPorDevolverService(dataSource as any, config as any, enviador as any, bitacora as any);
  return { servicio, dataSource, enviador, bitacora };
}

const AVISO = { id_pedido: 57, codigo: 'PED-20261125-0057', monto: 118, proveedor: 'culqi', referencia: 'ch_1', origen: 'webhook' as const };

describe('CobrosPorDevolverService (Fase 8.3)', () => {
  it('avisar: bitácora y correo al destino de los avisos; nunca reembolsa ni lanza', async () => {
    const { servicio, enviador, bitacora } = armar({ correo: 'dueno@ferreteria.pe' });

    await servicio.avisar(AVISO);

    const evento = (bitacora.registrarCon.mock.calls[0] as any[])[0]();
    expect(evento).toMatchObject({ accion: 'pedido.cobro_sobre_cancelado', entidad: 'pedido', id_entidad: 57, despues: { monto: 118, referencia: 'ch_1' } });
    const correo = (enviador.enviar.mock.calls[0] as any[])[0];
    expect(correo.para).toBe('dueno@ferreteria.pe');
    expect(correo.asunto).toContain('S/ 118.00');
    expect(correo.texto).toContain('PED-20261125-0057');
  });

  it('sin correo configurado o si el envío falla: no lanza (queda en el panel y en la bitácora)', async () => {
    const sin = armar({ correo: null });
    await expect(sin.servicio.avisar(AVISO)).resolves.toBeUndefined();
    expect(sin.enviador.enviar).not.toHaveBeenCalled();

    const falla = armar({ correo: 'dueno@ferreteria.pe', enviadorFalla: true });
    await expect(falla.servicio.avisar(AVISO)).resolves.toBeUndefined();
  });

  it('listar y contar: cobros aprobados de pedidos cancelados que no están marcados como devueltos', async () => {
    const { servicio, dataSource } = armar({ filas: [{ id_pago: 3, id_pedido: 57, codigo: 'X', monto: '118.00', fecha: 'f', cliente: 'Ana Ruiz' }] });

    const lista = await servicio.listar();

    expect(lista[0]).toMatchObject({ id_pago: 3, id_pedido: 57, monto: 118, cliente: 'Ana Ruiz' });
    const sql = String((dataSource.query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("pp.estado = 'aprobado'");
    expect(sql).toContain("p.estado = 'cancelado'");
    expect(sql).toContain("? 'hs_devolucion'");
    dataSource.query.mockRejectedValueOnce(new Error('sin base'));
    await expect(servicio.contar()).resolves.toBe(0);
  });

  it('marcarDevuelto: una sola vez (UPDATE condicional) y queda en la bitácora; 400 si ya estaba; 404 si no aplica', async () => {
    const ok = armar({ filas: [{ id_pago: 3, id_pedido: 57, monto: '118.00' }] });
    await expect(ok.servicio.marcarDevuelto(3, { id_usuario: 1, rol: 'admin' } as any, 'REF-1')).resolves.toEqual({ id_pago: 3, devuelto: true });
    const [sql, params] = ok.dataSource.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("NOT (COALESCE(pp.respuesta, '{}'::jsonb) ? 'hs_devolucion')");
    expect(params).toEqual([3, 1, 'REF-1']);
    expect(ok.bitacora.registrarCon).toHaveBeenCalledTimes(1);

    const ya = armar();
    ya.dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ estado: 'aprobado', estado_pedido: 'cancelado', marcado: true }]);
    await expect(ya.servicio.marcarDevuelto(3)).rejects.toBeInstanceOf(BadRequestException);

    const no = armar();
    await expect(no.servicio.marcarDevuelto(3)).rejects.toBeInstanceOf(NotFoundException);
  });
});
