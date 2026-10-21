import { BadRequestException } from '@nestjs/common';
import { VentaRepository } from '../../repository/Repository/venta.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { CrearVentaRequest } from '../../models/model/venta/venta.request';
import { calcularComprobante } from '../../util/fiscal/calculo-fiscal';
import { VentaBussnies } from './venta.bussnies';

describe('VentaBussnies: preview de descuentos por unidad', () => {
  it('multiplica el descuento decimal por la cantidad antes de calcular el comprobante', async () => {
    const producto = {
      id_producto: 7,
      nombre: 'CEMENTO',
      precio_venta: 10,
      descuento: 0,
      sku: 'CEM-01',
      codigo_barras: '',
      unidad_medida: 'NIU',
      stock_disponible: 10,
      reglas_mayoristas: [],
    };
    const repo = {
      cargarProductos: jest.fn().mockResolvedValue(new Map([[7, producto]])),
    };
    const config = { obtenerNumero: jest.fn().mockResolvedValue(18) };
    const comprobantes = { previsualizar: jest.fn(async (solicitud) => solicitud) };
    const servicio = new VentaBussnies(
      repo as unknown as VentaRepository,
      config as unknown as ConfiguracionRepository,
      comprobantes as unknown as ComprobanteBussnies,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await servicio.previsualizar({
      id_tipo: 2,
      items: [{ id_producto: 7, cantidad: 2, precio_unitario: 10, descuento: 0.2 }],
    } as CrearVentaRequest);

    const solicitud = comprobantes.previsualizar.mock.calls[0][0];
    expect(solicitud.items[0]).toMatchObject({
      cantidad: 2,
      precio_unitario: 10,
      descuento: 0.4,
    });
    const resumen = calcularComprobante([{
      cantidad: solicitud.items[0].cantidad,
      precio_unitario: solicitud.items[0].precio_unitario,
      descuento: solicitud.items[0].descuento,
    }]);
    expect(resumen.lineas[0]).toMatchObject({ descuento: 0.4, total: 19.6 });
  });
});

describe('VentaBussnies: recargo por pago con tarjeta', () => {
  const PRODUCTO = {
    id_producto: 7,
    nombre: 'CEMENTO',
    precio_venta: 10,
    descuento: 0,
    sku: 'CEM-01',
    codigo_barras: '',
    unidad_medida: 'NIU',
    stock_disponible: 10,
    reglas_mayoristas: [],
  };
  const EFECTIVO = 1;
  const TARJETA = 2;
  const YAPE = 3;

  function crearServicio(porcentaje: number | null = 3) {
    const repo = {
      cargarProductos: jest.fn().mockResolvedValue(new Map([[7, PRODUCTO]])),
      registrar: jest.fn().mockResolvedValue({ id_venta: 9, existente: false }),
      obtener: jest.fn().mockResolvedValue({
        id_venta: 9,
        fecha: new Date('2026-10-20T12:00:00Z'),
        origen: 'mostrador',
        subtotal: 0,
        igv: 0,
        total: 0,
        items: [],
        pagos: [],
      }),
      buscarPorClaveIdempotencia: jest.fn().mockResolvedValue(null),
      listarAlmacenesPos: jest.fn().mockResolvedValue([]),
    };
    const config = {
      // El recargo se lee de otra clave que el IGV: el mock los distingue.
      obtenerNumero: jest.fn(async (clave: string, defecto: number) =>
        clave === 'pos_recargo_tarjeta_pct' ? (porcentaje ?? defecto) : 18),
      obtener: jest.fn().mockResolvedValue(null),
    };
    const comprobantes = {
      previsualizar: jest.fn(async (solicitud) => solicitud),
      generar: jest.fn().mockResolvedValue({ id_comprobante: 5, aceptada_sunat: true }),
      listarPorVenta: jest.fn().mockResolvedValue([]),
    };
    const receptor = {
      consumidorFinal: jest.fn().mockResolvedValue({ numero_documento: '00000000', denominacion: 'CLIENTES VARIOS' }),
    };
    const creditoRepo = {
      metodosConTipo: jest.fn().mockResolvedValue([
        { id_metodo: EFECTIVO, nombre: 'Efectivo', tipo: 'efectivo' },
        { id_metodo: TARJETA, nombre: 'Tarjeta', tipo: 'tarjeta' },
        { id_metodo: YAPE, nombre: 'Yape', tipo: 'billetera' },
      ]),
      idMetodoCredito: jest.fn().mockResolvedValue(null),
    };
    const cajaSesion = { configEstricto: jest.fn().mockResolvedValue({ modo: 'blando', bypassAdmin: false }) };
    const servicio = new VentaBussnies(
      repo as unknown as VentaRepository,
      config as unknown as ConfiguracionRepository,
      comprobantes as unknown as ComprobanteBussnies,
      receptor as never,
      creditoRepo as never,
      {} as never,
      {} as never,
      cajaSesion as never,
    );
    return { servicio, repo, config, comprobantes, creditoRepo };
  }

  /** 2 cementos a S/ 10 con S/ 0.20 de descuento c/u = S/ 19.60; 3 % = 0.588 → S/ 0.59. */
  const venta = (pagos: CrearVentaRequest['pagos']): CrearVentaRequest => ({
    id_tipo: 2,
    items: [{ id_producto: 7, cantidad: 2, precio_unitario: 10, descuento: 0.2 }],
    pagos,
  } as CrearVentaRequest);

  it('la vista previa suma el 3 % como línea de servicio al final y lo informa aparte', async () => {
    const { servicio, comprobantes } = crearServicio();

    const preview: any = await servicio.previsualizar(venta([{ id_metodo: TARJETA, monto: 0 }]));

    const solicitud = comprobantes.previsualizar.mock.calls[0][0];
    expect(solicitud.items).toHaveLength(2);
    expect(solicitud.items[0]).toMatchObject({ id_producto: 7, cantidad: 2, descuento: 0.4 });
    expect(solicitud.items[1]).toEqual({
      codigo: 'RECARGO-TARJETA',
      unidad_de_medida: 'ZZ',
      descripcion: 'RECARGO POR PAGO CON TARJETA (3%)',
      cantidad: 1,
      precio_unitario: 0.59,
      descuento: 0,
      tipo_de_igv: 1,
    });
    expect(preview.recargo_tarjeta).toEqual({
      porcentaje: 3,
      base_tarjeta: 19.6,
      monto: 0.59,
      total_sin_recargo: 19.6,
    });
    // El comprobante resultante cuadra: productos + recargo = 20.19.
    const resumen = calcularComprobante(solicitud.items);
    expect(resumen.total).toBe(20.19);
    expect(resumen.total_gravada + resumen.total_igv).toBeCloseTo(20.19, 2);
  });

  it('en pago mixto recarga solo lo que queda para la tarjeta', async () => {
    const { servicio, comprobantes } = crearServicio();

    const preview: any = await servicio.previsualizar(
      venta([{ id_metodo: EFECTIVO, monto: 10 }, { id_metodo: TARJETA, monto: 0 }]),
    );

    expect(preview.recargo_tarjeta).toMatchObject({ base_tarjeta: 9.6, monto: 0.29, total_sin_recargo: 19.6 });
    expect(comprobantes.previsualizar.mock.calls[0][0].items[1]).toMatchObject({ precio_unitario: 0.29 });
  });

  it('sin pago con tarjeta no cambia nada y ni siquiera lee la configuración del recargo', async () => {
    const { servicio, comprobantes, config } = crearServicio();

    const preview: any = await servicio.previsualizar(venta([{ id_metodo: EFECTIVO, monto: 19.6 }]));
    await servicio.previsualizar(venta(undefined));

    for (const llamada of comprobantes.previsualizar.mock.calls) expect(llamada[0].items).toHaveLength(1);
    expect(preview.recargo_tarjeta).toBeUndefined();
    expect(config.obtenerNumero).not.toHaveBeenCalledWith('pos_recargo_tarjeta_pct', expect.anything());
  });

  it('Yape u otros medios que no son tarjeta no pagan recargo', async () => {
    const { servicio } = crearServicio();
    const preview: any = await servicio.previsualizar(venta([{ id_metodo: YAPE, monto: 19.6 }]));
    expect(preview.recargo_tarjeta).toBeUndefined();
  });

  it('con el recargo configurado en 0 % queda desactivado', async () => {
    const { servicio, comprobantes } = crearServicio(0);

    const preview: any = await servicio.previsualizar(venta([{ id_metodo: TARJETA, monto: 0 }]));

    expect(comprobantes.previsualizar.mock.calls[0][0].items).toHaveLength(1);
    expect(preview.recargo_tarjeta).toBeUndefined();
  });

  it('usa el porcentaje configurado y lo muestra en la descripción', async () => {
    const { servicio, comprobantes } = crearServicio(3.5);

    const preview: any = await servicio.previsualizar(venta([{ id_metodo: TARJETA, monto: 0 }]));

    expect(comprobantes.previsualizar.mock.calls[0][0].items[1]).toMatchObject({
      descripcion: 'RECARGO POR PAGO CON TARJETA (3.5%)',
      precio_unitario: 0.69,
    });
    expect(preview.recargo_tarjeta.porcentaje).toBe(3.5);
  });

  it('registrar: el total incluye el recargo, el detalle solo lleva productos y el comprobante declara la línea', async () => {
    const { servicio, repo, comprobantes } = crearServicio();

    const registrada = await servicio.registrar(
      venta([{ id_metodo: TARJETA, monto: 20.19, voucher_pos: 'V-123' }]),
      { id_usuario: 1, rol: 'admin' } as never,
    );

    expect(repo.registrar).toHaveBeenCalledTimes(1);
    const [datos, lineas, pagos] = repo.registrar.mock.calls[0];
    expect(datos).toMatchObject({ total: 20.19, subtotal: 17.11, igv: 3.08, descuento: 0.4 });
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({ id_producto: 7, cantidad: 2, descuento: 0.4, total: 19.6 });
    expect(pagos).toEqual([
      expect.objectContaining({ id_metodo: TARJETA, monto: 20.19, voucher_pos: 'V-123', validacion: 'pos_fisico' }),
    ]);

    const solicitud = comprobantes.generar.mock.calls[0][0];
    expect(solicitud.items).toHaveLength(2);
    expect(solicitud.items[1]).toMatchObject({ unidad_de_medida: 'ZZ', cantidad: 1, precio_unitario: 0.59 });
    // La BD y el comprobante suman lo mismo.
    expect(calcularComprobante(solicitud.items).total).toBe(datos.total);
    expect(registrada.recargo_tarjeta).toBe(0.59);
  });

  it('registrar: rechaza un pago con tarjeta que no incluye el recargo y no escribe nada', async () => {
    const { servicio, repo, comprobantes } = crearServicio();

    await expect(
      servicio.registrar(venta([{ id_metodo: TARJETA, monto: 19.6, voucher_pos: 'V-123' }]), { id_usuario: 1, rol: 'admin' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repo.registrar).not.toHaveBeenCalled();
    expect(comprobantes.generar).not.toHaveBeenCalled();
  });

  it('registrar en pago mixto: efectivo + tarjeta con el recargo solo sobre la tarjeta', async () => {
    const { servicio, repo } = crearServicio();

    // 10.00 en efectivo; la tarjeta cubre 9.60 + 3 % (0.29) = 9.89.
    await servicio.registrar(
      venta([{ id_metodo: EFECTIVO, monto: 10 }, { id_metodo: TARJETA, monto: 9.89, voucher_pos: 'V-9' }]),
      { id_usuario: 1, rol: 'admin' } as never,
    );

    const [datos, , pagos] = repo.registrar.mock.calls[0];
    expect(datos.total).toBe(19.89);
    expect(pagos.map((p: { monto: number }) => p.monto)).toEqual([10, 9.89]);
  });

  it('el contexto del POS informa el porcentaje vigente para el cálculo en vivo', async () => {
    const { servicio } = crearServicio();
    expect(await servicio.contextoPos()).toMatchObject({ almacenes: [], recargo_tarjeta_pct: 3 });

    const apagado = crearServicio(0);
    expect(await apagado.servicio.contextoPos()).toMatchObject({ recargo_tarjeta_pct: 0 });
  });
});
