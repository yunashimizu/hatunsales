import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PedidoComprobanteBussnies } from './pedido-comprobante.bussnies';

/**
 * Comprobante de los pedidos web (S5): se emite al confirmar el pago, con envío diferido y el correo del comprador,
 * y un fallo nunca deshace la confirmación (queda registrado con su motivo).
 */

const DATOS_BOLETA = {
  id_pedido: 7, codigo: 'PED-20261108-0007', id_venta: 99, id_cliente: 3, tipo_comprobante: 'boleta' as const,
  documento_receptor: '45678912', nombre_receptor: 'Rosa Quispe', correo: 'rosa@correo.pe', direccion: 'Jr. Lima 45, Cusco',
};

function escenario(opciones: {
  datos?: any; activo?: boolean; venta?: any; error?: any; comprobantes?: any[]; ultimo?: any;
} = {}) {
  const datos = opciones.datos === undefined ? DATOS_BOLETA : opciones.datos;
  const ventaRepo = {
    datosParaComprobante: jest.fn(async () => datos),
    vincularComprobante: jest.fn(async () => undefined),
  };
  const ventas = {
    emitirComprobanteDeVenta: jest.fn(async () => {
      if (opciones.error) throw opciones.error;
      return opciones.venta ?? { id_venta: 99, comprobante: { id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: false, estado_sunat: 'ENVIANDO' } };
    }),
  };
  const comprobantes = {
    emisionDisponible: jest.fn(async () => (opciones.activo === false ? { activo: false, motivo: 'FISCAL_EMISION_INACTIVA' } : { activo: true })),
    listarPorVenta: jest.fn(async () => opciones.comprobantes ?? []),
    obtenerPdf: jest.fn(async (id: number) => ({ nombre: `B001-123.pdf`, contenido: Buffer.from(`pdf-${id}`) })),
  };
  const auditoria = {
    registrar: jest.fn(async () => undefined),
    ultimoDeEntidad: jest.fn(async () => opciones.ultimo ?? null),
  };
  const servicio = new PedidoComprobanteBussnies(ventaRepo as any, ventas as any, comprobantes as any, auditoria as any);
  return { servicio, ventaRepo, ventas, comprobantes, auditoria };
}

describe('PedidoComprobanteBussnies.emitirDePedido', () => {
  it('emite la boleta con envío diferido forzado, el DNI y el correo del comprador', async () => {
    const { servicio, ventas, ventaRepo, auditoria } = escenario();

    const resultado = await servicio.emitirDePedido(7, 99);

    expect(resultado).toEqual({ emitido: true, id_comprobante: 12 });
    const [idVenta, dto, usuario, opciones] = ventas.emitirComprobanteDeVenta.mock.calls[0] as any[];
    expect(idVenta).toBe(99);
    expect(dto).toMatchObject({ id_tipo: 2, documento: '45678912', cliente_denominacion: 'Rosa Quispe', cliente_direccion: 'Jr. Lima 45, Cusco' });
    expect(dto.observaciones).toContain('PED-20261108-0007');
    expect(usuario).toBeUndefined();
    expect(opciones).toEqual({ forzarDiferido: true, correo_cliente: 'rosa@correo.pe' });
    expect(ventaRepo.vincularComprobante).toHaveBeenCalledWith(7, 12);
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'FISCAL_PEDIDO_WEB_EMITIDO', entidad: 'pedido', id_entidad: 7,
      detalle: expect.objectContaining({ resultado: 'ok', id_comprobante: 12 }),
    }));
  });

  it('factura con RUC: pide el tipo factura con el RUC del pedido', async () => {
    const { servicio, ventas } = escenario({
      datos: { ...DATOS_BOLETA, tipo_comprobante: 'factura', documento_receptor: '20123456789', nombre_receptor: 'Constructora Andina SAC' },
    });

    await servicio.emitirDePedido(7, 99);

    const dto = (ventas.emitirComprobanteDeVenta.mock.calls[0] as any[])[1];
    expect(dto).toMatchObject({ id_tipo: 1, documento: '20123456789', cliente_denominacion: 'Constructora Andina SAC' });
  });

  it('factura sin RUC válido: no intenta emitir y deja el motivo en la bitácora', async () => {
    const { servicio, ventas, auditoria } = escenario({ datos: { ...DATOS_BOLETA, tipo_comprobante: 'factura', documento_receptor: '45678912' } });

    const resultado = await servicio.emitirDePedido(7, 99);

    expect(resultado.emitido).toBe(false);
    expect(resultado.motivo).toMatch(/RUC válido/);
    expect(ventas.emitirComprobanteDeVenta).not.toHaveBeenCalled();
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      detalle: expect.objectContaining({ resultado: 'sin_comprobante', motivo: expect.stringMatching(/RUC/) }),
    }));
  });

  it('boleta sin DNI: no manda documento (se usa al cliente de la tienda) y un correo malo no se manda', async () => {
    const { servicio, ventas } = escenario({ datos: { ...DATOS_BOLETA, documento_receptor: null, correo: 'no-es-correo' } });

    await servicio.emitirDePedido(7, 99);

    const [, dto, , opciones] = ventas.emitirComprobanteDeVenta.mock.calls[0] as any[];
    expect(dto.documento).toBeUndefined();
    expect(opciones.correo_cliente).toBeUndefined();
  });

  it('con la emisión apagada no intenta nada ni toca la bitácora', async () => {
    const { servicio, ventas, ventaRepo, auditoria } = escenario({ activo: false });

    const resultado = await servicio.emitirDePedido(7, 99);

    expect(resultado).toMatchObject({ emitido: false, omitido: true });
    expect(resultado.motivo).toMatch(/no está activa/);
    expect(ventaRepo.datosParaComprobante).not.toHaveBeenCalled();
    expect(ventas.emitirComprobanteDeVenta).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si la emisión lanza un error, no lo propaga: responde sin comprobante y registra el motivo', async () => {
    const { servicio, auditoria } = escenario({ error: new Error('La línea 2 se vendió sin IGV') });

    const resultado = await servicio.emitirDePedido(7, 99);

    expect(resultado).toEqual({ emitido: false, motivo: 'La línea 2 se vendió sin IGV' });
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      detalle: expect.objectContaining({ resultado: 'sin_comprobante', motivo: 'La línea 2 se vendió sin IGV' }),
    }));
  });

  it('si la emisión responde sin comprobante, usa el error que devolvió', async () => {
    const { servicio } = escenario({ venta: { id_venta: 99, comprobante_error: 'SUNAT: serie sin correlativo', comprobante_pendiente: true } });

    await expect(servicio.emitirDePedido(7, 99)).resolves.toEqual({ emitido: false, motivo: 'SUNAT: serie sin correlativo' });
  });

  it('si la venta ya tenía su comprobante (alguien lo emitió antes) no es un fallo', async () => {
    const error = new ConflictException({ message: 'ya tiene', codigo: 'VENTA_CON_COMPROBANTE', id_comprobante: 40 });
    const { servicio, auditoria } = escenario({ error });

    await expect(servicio.emitirDePedido(7, 99)).resolves.toEqual({ emitido: true, id_comprobante: 40 });
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('una bitácora caída no hace fallar la emisión', async () => {
    const e = escenario();
    e.auditoria.registrar.mockRejectedValue(new Error('sin tabla'));

    await expect(e.servicio.emitirDePedido(7, 99)).resolves.toMatchObject({ emitido: true });
  });
});

describe('PedidoComprobanteBussnies.resumenDe', () => {
  const pedido = { id_pedido: 7, id_venta: 99, tipo_comprobante: 'boleta', estado: 'pagado' };

  it.each([
    [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: true, estado_sunat: 'ACEPTADO', tipo_de_comprobante: 2 }, 'aceptado', true],
    [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: false, estado_sunat: 'ENVIANDO', tipo_de_comprobante: 2 }, 'en_proceso', true],
    [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: false, estado_sunat: 'EXCEPCION', tipo_de_comprobante: 2 }, 'requiere_revision', false],
    [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: false, estado_sunat: 'RECHAZADO', tipo_de_comprobante: 2 }, 'rechazado', false],
    [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: true, anulado: true, tipo_de_comprobante: 2 }, 'anulado', false],
  ])('traduce el comprobante %j a «%s» (descargable: %s)', async (comprobante, estado, descargable) => {
    const { servicio } = escenario({ comprobantes: [comprobante] });

    const resumen = await servicio.resumenDe(pedido, true);

    expect(resumen).toMatchObject({ estado, puede_descargar: descargable, id_comprobante: 12, numero_formateado: 'B001-123' });
  });

  it('una factura se reconoce como factura', async () => {
    const { servicio } = escenario({ comprobantes: [{ id_comprobante: 3, numero_formateado: 'F001-9', aceptada_sunat: true, tipo_de_comprobante: 1 }] });
    await expect(servicio.resumenDe(pedido, false)).resolves.toMatchObject({ tipo: 'factura' });
  });

  it('sin comprobante: el personal ve el motivo del último intento; el comprador no', async () => {
    const ultimo = { detalle: { resultado: 'sin_comprobante', motivo: 'El comprador pidió factura sin RUC' } };
    const { servicio } = escenario({ ultimo });

    await expect(servicio.resumenDe(pedido, true)).resolves.toEqual({
      estado: 'sin_comprobante', puede_descargar: false, motivo: 'El comprador pidió factura sin RUC',
    });
    await expect(servicio.resumenDe(pedido, false)).resolves.toEqual({ estado: 'sin_comprobante', puede_descargar: false });
  });

  it('sin comprobante ni intento registrado, el motivo orienta a «Ventas sin comprobante»', async () => {
    const { servicio } = escenario();
    const resumen = await servicio.resumenDe(pedido, true);
    expect(resumen.motivo).toMatch(/Ventas sin comprobante/);
  });

  it('un pedido pendiente o sin venta explica que el comprobante nace al pagar', async () => {
    const { servicio } = escenario();
    const resumen = await servicio.resumenDe({ id_pedido: 8, id_venta: null, estado: 'pendiente' }, true);
    expect(resumen).toMatchObject({ estado: 'sin_comprobante', motivo: expect.stringMatching(/al confirmar el pago/) });
  });
});

describe('PedidoComprobanteBussnies.pdfParaCliente', () => {
  const pedido = { id_venta: 99, tipo_comprobante: 'boleta', cliente: { id_cliente: 3 } };
  const aceptado = [{ id_comprobante: 12, numero_formateado: 'B001-123', aceptada_sunat: true, tipo_de_comprobante: 2 }];

  it('entrega el PDF A4 al dueño del pedido', async () => {
    const { servicio, comprobantes } = escenario({ comprobantes: aceptado });

    const pdf = await servicio.pdfParaCliente(7, 3, pedido);

    expect(pdf.contenido.toString()).toBe('pdf-12');
    expect(comprobantes.obtenerPdf).toHaveBeenCalledWith(12, 'a4');
  });

  it('un pedido de otra persona responde 403 y no arma ningún PDF', async () => {
    const { servicio, comprobantes } = escenario({ comprobantes: aceptado });

    await expect(servicio.pdfParaCliente(7, 999, pedido)).rejects.toBeInstanceOf(ForbiddenException);
    expect(comprobantes.obtenerPdf).not.toHaveBeenCalled();
  });

  it('sin comprobante, rechazado o anulado responde 404 con un texto amable', async () => {
    const sin = escenario();
    await expect(sin.servicio.pdfParaCliente(7, 3, pedido)).rejects.toBeInstanceOf(NotFoundException);

    const rechazado = escenario({ comprobantes: [{ id_comprobante: 12, estado_sunat: 'RECHAZADO', aceptada_sunat: false }] });
    await expect(rechazado.servicio.pdfParaCliente(7, 3, pedido)).rejects.toThrow(/todavía no está disponible/);
    expect(rechazado.comprobantes.obtenerPdf).not.toHaveBeenCalled();
  });

  it('un pedido que no existe responde 404', async () => {
    const { servicio } = escenario();
    await expect(servicio.pdfParaCliente(7, 3, null)).rejects.toBeInstanceOf(NotFoundException);
  });
});
