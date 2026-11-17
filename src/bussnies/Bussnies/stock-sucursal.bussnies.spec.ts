import { BadRequestException } from '@nestjs/common';
import { MENSAJE_ESCRITURA_LEGADA, StockSucursalBussnies } from './stock-sucursal.bussnies';
import { StockSucursalController } from '../../api/controllers/stock-sucursal.controller';

/**
 * B6: las escrituras legadas de /stock (PUT del stock y POST transfer) ya no escriben:
 * remiten a Inventario (Ajuste o Transferencia), que deja kardex. Las lecturas siguen.
 */
function armar() {
  const stockRepo = {
    buscarPorProductoYSucursal: jest.fn(async () => ({
      producto: { id_producto: 3 }, sucursal: { id_sucursal: 1 }, stock: 8, stock_comprometido: 0, actualizado_en: null,
    })),
    update: jest.fn(),
    create: jest.fn(),
  };
  const productoRepo = { getById: jest.fn() };
  const sucursalRepo = { getById: jest.fn() };
  const movimientoRepo = { create: jest.fn() };
  const servicio = new StockSucursalBussnies(stockRepo as never, productoRepo as never, sucursalRepo as never, movimientoRepo as never);
  return { servicio, stockRepo, productoRepo, movimientoRepo };
}

describe('StockSucursal · escrituras legadas retiradas (B6)', () => {
  it('PUT /stock/producto/:id/sucursal/:id responde 400 y no toca nada', async () => {
    const { servicio, stockRepo, movimientoRepo } = armar();
    const controlador = new StockSucursalController(servicio);

    await expect(controlador.updateStock()).rejects.toThrow(new BadRequestException(MENSAJE_ESCRITURA_LEGADA));
    expect(stockRepo.update).not.toHaveBeenCalled();
    expect(stockRepo.create).not.toHaveBeenCalled();
    expect(movimientoRepo.create).not.toHaveBeenCalled();
  });

  it('POST /stock/transfer responde 400 y no toca nada', async () => {
    const { servicio, stockRepo, movimientoRepo } = armar();
    const controlador = new StockSucursalController(servicio);

    await expect(controlador.transfer()).rejects.toBeInstanceOf(BadRequestException);
    expect(stockRepo.update).not.toHaveBeenCalled();
    expect(stockRepo.create).not.toHaveBeenCalled();
    expect(movimientoRepo.create).not.toHaveBeenCalled();
  });

  it('el mensaje remite a Inventario › Ajuste o Transferencia', () => {
    expect(MENSAJE_ESCRITURA_LEGADA).toBe('Use Inventario › Ajuste o Transferencia (quedan en el kardex).');
  });

  it('las lecturas siguen igual', async () => {
    const { servicio } = armar();
    const controlador = new StockSucursalController(servicio);

    await expect(controlador.getStock('3', '1')).resolves.toMatchObject({ id_producto: 3, id_sucursal: 1, stock: 8 });
  });
});
