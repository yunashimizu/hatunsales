import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { AlmacenDireccionService, validarDireccionAlmacen } from './almacen-direccion.service';

function armar(opciones: { fase22?: boolean; fila?: any; fiscal?: any } = {}) {
  const dataSource = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM almacenes a')) return opciones.fila === undefined ? [] : [opciones.fila];
      if (sql.includes('WHERE id_almacen = ANY')) return [{ id_almacen: 1, direccion: 'Av. Propia 1', ubigeo: '150101', codigo_establecimiento: null }];
      return [];
    }),
  };
  const esquema = { tiene: jest.fn(async () => opciones.fase22 ?? true) };
  const fiscal = { gre: jest.fn(async () => ({ partida: opciones.fiscal ?? { direccion: 'Jr. Fiscal 9', ubigeo: '150102', codigoEstablecimiento: '0000' } })) };
  return { servicio: new AlmacenDireccionService(dataSource as any, esquema as any, fiscal as any), dataSource, esquema, fiscal };
}

describe('AlmacenDireccionService (Fase 4.4)', () => {
  it('valida: solo lo que llega, vacío → null, ubigeo de 6 dígitos y establecimiento de 4', () => {
    expect(validarDireccionAlmacen({ nombre: 'x' })).toEqual({});
    expect(validarDireccionAlmacen({ direccion: '  Av. 1 ', ubigeo: '', codigo_establecimiento: null }))
      .toEqual({ direccion: 'Av. 1', ubigeo: null, codigo_establecimiento: null });
    expect(() => validarDireccionAlmacen({ ubigeo: '1501' })).toThrow(BadRequestException);
    expect(() => validarDireccionAlmacen({ codigo_establecimiento: '00001' })).toThrow(/4 dígitos/);
    expect(() => validarDireccionAlmacen({ direccion: 'x'.repeat(201) })).toThrow(/200/);
  });

  it('sin fase22: con valor → 503 ALMACEN_DIRECCION_NO_DISPONIBLE; vacío o ausente se ignora', async () => {
    const { servicio } = armar({ fase22: false });
    const error: any = await servicio.preparar({ direccion: 'Av. 1' }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse().codigo).toBe('ALMACEN_DIRECCION_NO_DISPONIBLE');
    await expect(servicio.preparar({ direccion: '', ubigeo: null })).resolves.toEqual({});
    await expect(servicio.preparar({ nombre: 'Solo nombre' })).resolves.toEqual({});
    await expect(servicio.deAlmacenes([1])).resolves.toEqual(new Map());
  });

  it('con fase22 guarda solo las columnas que llegaron', async () => {
    const { servicio, dataSource } = armar();
    await servicio.guardar(3, await servicio.preparar({ direccion: 'Av. 2', ubigeo: '' }));
    expect(dataSource.query).toHaveBeenCalledWith('UPDATE almacenes SET direccion = $2, ubigeo = $3 WHERE id_almacen = $1', [3, 'Av. 2', null]);
    dataSource.query.mockClear();
    await servicio.guardar(3, {});
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('partida: la propia del almacén; si no tiene, la de su sucursal (sin ubigeo); si tampoco, la fiscal', async () => {
    const fila = { id_almacen: 1, almacen: 'Principal', id_sucursal: 2, sucursal: 'Central', direccion_sucursal: 'Av. Sucursal 5' };
    const propia = await armar({ fila: { ...fila, direccion: 'Av. Propia 1', ubigeo: '150101', codigo_establecimiento: '0001' } }).servicio.partida(1);
    expect(propia).toMatchObject({ origen: 'almacen', direccion: 'Av. Propia 1', ubigeo: '150101', codigo_establecimiento: '0001', completa: true, direccion_propia_disponible: true });

    const deSucursal = await armar({ fila: { ...fila, direccion: null } }).servicio.partida(1);
    expect(deSucursal).toMatchObject({ origen: 'sucursal', direccion: 'Av. Sucursal 5', ubigeo: null, completa: false });

    const sinFase22 = armar({ fase22: false, fila: { ...fila, direccion_sucursal: '' } });
    const fiscal = await sinFase22.servicio.partida(1);
    expect(fiscal).toMatchObject({ origen: 'configuracion', direccion: 'Jr. Fiscal 9', ubigeo: '150102', codigo_establecimiento: '0000', completa: true, direccion_propia_disponible: false });
    expect(String(sinFase22.dataSource.query.mock.calls[0][0])).not.toContain('a.ubigeo');

    const nada = armar({ fila: { ...fila, direccion: null, direccion_sucursal: null }, fiscal: { direccion: '', ubigeo: '', codigoEstablecimiento: '' } });
    await expect(nada.servicio.partida(1)).resolves.toMatchObject({ origen: 'ninguno', direccion: null });

    await expect(armar().servicio.partida(99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
