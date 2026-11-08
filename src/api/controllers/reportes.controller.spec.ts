import { BadRequestException } from '@nestjs/common';
import { ReportesController } from './reportes.controller';

function respuesta() {
  const res: any = { cabeceras: {} as Record<string, string>, cuerpo: undefined as unknown, estado: 200 };
  res.setHeader = jest.fn((k: string, v: string) => { res.cabeceras[k] = v; });
  res.send = jest.fn((c: unknown) => { res.cuerpo = c; return res; });
  res.status = jest.fn((e: number) => { res.estado = e; return res; });
  res.json = jest.fn((c: unknown) => { res.cuerpo = c; return res; });
  return res;
}

const archivo = (contenido: string, nombre: string, tipo: string) => ({
  contenido,
  nombre,
  tipo,
  resumen: { periodo: '202610', filas: 1, aviso: 'Estructura basada en PLE 14.1; el contador debe validar el primer archivo contra la propuesta SIRE.' },
});

describe('ReportesController · registro de ventas (SIRE)', () => {
  it('el TXT se descarga como adjunto UTF-8 sin BOM, con el resumen en una cabecera legible por el panel', async () => {
    const service = { registroVentasRvie: jest.fn().mockResolvedValue(archivo('a|b\r\n', 'LE20610206337.txt', 'text/plain; charset=utf-8')) };
    const res = respuesta();

    await new ReportesController(service as any, {} as any).ventasRvie(res, '202610');

    expect(service.registroVentasRvie).toHaveBeenCalledWith('202610');
    expect(res.cabeceras['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.cabeceras['Content-Disposition']).toBe('attachment; filename="LE20610206337.txt"');
    expect(res.cabeceras['Access-Control-Expose-Headers']).toContain('X-Rvie-Resumen');
    expect(JSON.parse(decodeURIComponent(res.cabeceras['X-Rvie-Resumen']))).toMatchObject({ periodo: '202610', filas: 1 });
    expect((res.cuerpo as Buffer).toString('utf8')).toBe('a|b\r\n');
    expect((res.cuerpo as Buffer)[0]).not.toBe(0xef);
  });

  it('el CSV conserva su BOM para que Excel lea las tildes', async () => {
    const service = { registroVentasRvieCsv: jest.fn().mockResolvedValue(archivo('﻿x,y\r\n', 'registro.csv', 'text/csv; charset=utf-8')) };
    const res = respuesta();

    await new ReportesController(service as any, {} as any).ventasRvieCsv(res, '202610');

    expect(res.cabeceras['Content-Type']).toBe('text/csv; charset=utf-8');
    expect([...(res.cuerpo as Buffer).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('un periodo inválido responde 400 con el mensaje, no un archivo', async () => {
    const service = {
      registroVentasRvie: jest.fn().mockRejectedValue(new BadRequestException({ message: 'Periodo inválido: use el mes en formato AAAAMM.' })),
    };
    const res = respuesta();

    await new ReportesController(service as any, {} as any).ventasRvie(res, undefined);

    expect(service.registroVentasRvie).toHaveBeenCalledWith('');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.cuerpo).toMatchObject({ message: expect.stringContaining('AAAAMM') });
    expect(res.cabeceras['Content-Disposition']).toBeUndefined();
  });

  it('solo el administrador puede pedirlo (rol declarado en la ruta)', () => {
    const roles = Reflect.getMetadata('roles', ReportesController.prototype.ventasRvie);
    const rolesCsv = Reflect.getMetadata('roles', ReportesController.prototype.ventasRvieCsv);
    expect(roles).toEqual(['admin']);
    expect(rolesCsv).toEqual(['admin']);
  });
});

describe('ReportesController · Fase F (rentabilidad, mapa de calor, resumen diario)', () => {
  it('rentabilidad, estancados y todo el resumen diario son solo del administrador', () => {
    const rolesDe = (metodo: string) => Reflect.getMetadata('roles', (ReportesController.prototype as any)[metodo]);
    for (const metodo of [
      'rentabilidadProductos',
      'productosEstancados',
      'resumenDiarioConfiguracion',
      'guardarResumenDiarioConfiguracion',
      'enviarResumenDiarioAhora',
    ]) {
      expect(rolesDe(metodo)).toEqual(['admin']);
    }
    expect(rolesDe('ventasMapaCalor')).toEqual(['admin', 'vendedor', 'caja']);
  });

  it('pasa los parámetros de la URL a los servicios', async () => {
    const service = {
      rentabilidadProductos: jest.fn().mockResolvedValue({}),
      productosEstancados: jest.fn().mockResolvedValue({}),
      ventasMapaCalor: jest.fn().mockResolvedValue({}),
    };
    const resumen = { enviarAhora: jest.fn().mockResolvedValue({ enviados: ['a@b.pe'] }) };
    const c = new ReportesController(service as any, resumen as any);

    await c.rentabilidadProductos('2026-11-01', '2026-11-08');
    await c.productosEstancados('60');
    await c.ventasMapaCalor('8');
    await expect(c.enviarResumenDiarioAhora()).resolves.toEqual({ enviados: ['a@b.pe'] });

    expect(service.rentabilidadProductos).toHaveBeenCalledWith({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });
    expect(service.productosEstancados).toHaveBeenCalledWith('60');
    expect(service.ventasMapaCalor).toHaveBeenCalledWith('8');
  });
});
