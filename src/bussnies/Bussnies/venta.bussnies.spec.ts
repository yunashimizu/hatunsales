import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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

describe('VentaBussnies: comprobante de la venta (emisión directa)', () => {
  const EFECTIVO = 1;
  const TARJETA = 2;
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
    codigo_sunat: '30111601',
  };
  const CABECERA = {
    id_venta: 9,
    fecha: new Date('2026-10-21T15:00:00Z'),
    origen: 'mostrador',
    subtotal: 17.11,
    igv: 3.08,
    total: 20.19,
    items: [],
    pagos: [],
  };

  /** Venta 9 guardada: 2 cementos a S/ 10 con S/ 0.40 de descuento, cobrada con tarjeta (+ S/ 0.59). */
  function ventaGuardada(parcial: Record<string, unknown> = {}) {
    return {
      id_venta: 9,
      estado: 'activa',
      origen: 'mostrador',
      total: 20.19,
      id_cliente: 17,
      id_empresa: null,
      lineas: [
        {
          id_producto: 7,
          descripcion: 'CEMENTO',
          codigo: 'CEM-01',
          unidad_de_medida: 'NIU',
          codigo_sunat: '30111601',
          cantidad: 2,
          precio: 10,
          precio_lista_unitario: 10,
          descuento_total_linea: 0.4,
          subtotal: 16.61,
          igv: 2.99,
          total: 19.6,
        },
      ],
      pagos: [{ id_metodo: TARJETA, monto: 20.19, metodo: 'Tarjeta', tipo: 'tarjeta' }],
      credito: null,
      ...parcial,
    };
  }

  function crear() {
    const repo = {
      cargarProductos: jest.fn().mockResolvedValue(new Map([[7, PRODUCTO]])),
      registrar: jest.fn().mockResolvedValue({ id_venta: 9, existente: false }),
      obtener: jest.fn().mockResolvedValue(CABECERA),
      buscarPorClaveIdempotencia: jest.fn().mockResolvedValue(null),
      obtenerParaComprobante: jest.fn().mockResolvedValue(ventaGuardada()),
    };
    const config = {
      obtenerNumero: jest.fn(async (clave: string, defecto: number) => (clave === 'pos_recargo_tarjeta_pct' ? 3 : clave === 'tienda_igv_porcentaje' ? 18 : defecto)),
      obtener: jest.fn().mockResolvedValue(null),
    };
    const comprobantes = {
      generar: jest.fn().mockResolvedValue({ id_comprobante: 5, tipo_de_comprobante: 2, aceptada_sunat: true, estado: 'emitido' }),
      listarPorVenta: jest.fn().mockResolvedValue([]),
    };
    const receptor = {
      consumidorFinal: jest.fn().mockResolvedValue({ origen: 'generico', tipo_documento: 1, numero_documento: '00000000', denominacion: 'CLIENTES VARIOS' }),
      buscarPorDocumento: jest.fn().mockResolvedValue({ origen: 'base', id_empresa: 31, tipo_documento: 6, numero_documento: '20123456789', denominacion: 'FERRETERIA EL MARTILLO S.A.C.' }),
      porIdCliente: jest.fn().mockResolvedValue({ origen: 'base', id_cliente: 17, tipo_documento: 1, numero_documento: '45678912', denominacion: 'JUAN PEREZ' }),
      porIdEmpresa: jest.fn(),
    };
    const creditoRepo = {
      metodosConTipo: jest.fn().mockResolvedValue([
        { id_metodo: EFECTIVO, nombre: 'Efectivo', tipo: 'efectivo' },
        { id_metodo: TARJETA, nombre: 'Tarjeta', tipo: 'tarjeta' },
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
    return { servicio, repo, comprobantes, receptor };
  }

  const USUARIO = { id_usuario: 4, rol: 'caja' } as never;

  describe('registrar', () => {
    it('pasa el usuario a generar, la forma de pago tipada y el código SUNAT del producto', async () => {
      const { servicio, comprobantes } = crear();

      await servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      const [solicitud, idUsuario] = comprobantes.generar.mock.calls[0];
      expect(idUsuario).toBe(4);
      expect(solicitud).toMatchObject({ forma_pago: 'Contado', id_venta: 9 });
      expect(solicitud.items[0]).toMatchObject({ id_producto: 7, codigo_producto_sunat: '30111601' });
      // Consumidor final: no se manda el 00000000 como si fuera un DNI.
      expect(solicitud.documento).toBeUndefined();
    });

    it('reintento con la clave ya usada y la venta sin comprobante: lo informa para ofrecer emitirlo', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.buscarPorClaveIdempotencia.mockResolvedValue(9);

      const venta = await servicio.registrar(
        { id_tipo: 2, clave_idempotencia: 'abc-1', items: [{ id_producto: 7, cantidad: 1 }] } as CrearVentaRequest,
        USUARIO,
      );

      expect(venta.comprobante_pendiente).toBe(true);
      expect(venta.comprobante_error).toContain('Emitir comprobante');
      expect(repo.registrar).not.toHaveBeenCalled();
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('reintento con un comprobante vigente o en curso, o sin pedir comprobante: no marca nada', async () => {
      const enCurso = crear();
      enCurso.repo.buscarPorClaveIdempotencia.mockResolvedValue(9);
      enCurso.comprobantes.listarPorVenta.mockResolvedValue([{ id_comprobante: 5, tipo_de_comprobante: 2, estado: 'pendiente', anulado: false }]);
      const conComprobante = await enCurso.servicio.registrar({ id_tipo: 2, clave_idempotencia: 'abc-1', items: [{ id_producto: 7, cantidad: 1 }] } as CrearVentaRequest, USUARIO);
      expect(conComprobante.comprobante_pendiente).toBeUndefined();

      const sinPedir = crear();
      sinPedir.repo.buscarPorClaveIdempotencia.mockResolvedValue(9);
      const venta = await sinPedir.servicio.registrar(
        { id_tipo: 2, clave_idempotencia: 'abc-1', emitir_comprobante: false, items: [{ id_producto: 7, cantidad: 1 }] } as CrearVentaRequest,
        USUARIO,
      );
      expect(venta.comprobante_pendiente).toBeUndefined();
    });

    it('la carrera de idempotencia resuelta en el repositorio (existente) también informa el pendiente', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.registrar.mockResolvedValue({ id_venta: 9, existente: true });
      comprobantes.listarPorVenta.mockResolvedValue([{ id_comprobante: 5, tipo_de_comprobante: 2, estado: 'error', anulado: false }]);

      const venta = await servicio.registrar(
        { id_tipo: 2, clave_idempotencia: 'abc-1', items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      expect(venta.comprobante_pendiente).toBe(true);
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('un comprobante no aceptado por SUNAT (en cualquier ambiente) llega como comprobante_error', async () => {
      const { servicio, comprobantes } = crear();
      comprobantes.generar.mockResolvedValue({
        id_comprobante: 5, aceptada_sunat: false, estado: 'pendiente', ambiente_fiscal: 'produccion', error: 'SUNAT no respondió; se reintentará',
      });

      const venta = await servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      expect(venta.comprobante_error).toBe('SUNAT no respondió; se reintentará');
      // Con el envío en curso el comprobante sigue siendo el de la venta: no se ofrece otro.
      expect(venta.comprobante_pendiente).toBeUndefined();
    });

    it('si no se pudo emitir o SUNAT lo rechazó, la venta queda con el comprobante pendiente de emitir', async () => {
      const inactiva = crear();
      inactiva.comprobantes.generar.mockRejectedValue(new ServiceUnavailableException('la emisión electrónica no está activa'));
      const sinComprobante = await inactiva.servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );
      expect(sinComprobante).toMatchObject({ comprobante_pendiente: true, comprobante_error: 'la emisión electrónica no está activa' });

      const rechazada = crear();
      rechazada.comprobantes.generar.mockResolvedValue({
        id_comprobante: 5, aceptada_sunat: false, estado: 'error', estado_sunat: 'RECHAZADO', error: 'El RUC del receptor no existe',
      });
      const conRechazo = await rechazada.servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );
      expect(conRechazo).toMatchObject({ comprobante_pendiente: true, comprobante_error: 'El RUC del receptor no existe' });
    });
  });

  describe('emitirComprobanteDeVenta', () => {
    it('usa las líneas guardadas tal como se cobraron, agrega el recargo por tarjeta y exige el total exacto', async () => {
      const { servicio, comprobantes } = crear();

      const venta = await servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);

      const [solicitud, idUsuario, opciones] = comprobantes.generar.mock.calls[0];
      expect(idUsuario).toBe(4);
      expect(opciones).toEqual({ totalExigido: 20.19 });
      expect(solicitud).toMatchObject({ id_tipo: 2, id_venta: 9, forma_pago: 'Contado', medio_de_pago: 'Tarjeta' });
      expect(solicitud.items).toEqual([
        expect.objectContaining({ id_producto: 7, cantidad: 2, precio_unitario: 10, descuento: 0.4, codigo_producto_sunat: '30111601' }),
        expect.objectContaining({ unidad_de_medida: 'ZZ', cantidad: 1, precio_unitario: 0.59, codigo: 'RECARGO-TARJETA' }),
      ]);
      expect(calcularComprobante(solicitud.items).total).toBe(20.19);
      expect(venta.comprobante).toMatchObject({ id_comprobante: 5 });
    });

    it('no usa precios del catálogo: una venta antigua sin columnas de descuento se reconstruye desde su total', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.obtenerParaComprobante.mockResolvedValue(ventaGuardada({
        total: 19.6,
        pagos: [{ id_metodo: EFECTIVO, monto: 19.6, metodo: 'Efectivo', tipo: 'efectivo' }],
        lineas: [{ ...ventaGuardada().lineas[0], precio_lista_unitario: null, descuento_total_linea: null }],
      }));

      await servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);

      const solicitud = comprobantes.generar.mock.calls[0][0];
      expect(solicitud.items).toHaveLength(1);
      expect(solicitud.items[0]).toMatchObject({ precio_unitario: 10, descuento: 0.4 });
      expect(repo.obtenerParaComprobante).toHaveBeenCalledWith(9);
    });

    it('409 si la venta ya tiene un comprobante vigente o en curso', async () => {
      const { servicio, comprobantes } = crear();
      comprobantes.listarPorVenta.mockResolvedValue([{ id_comprobante: 5, tipo_de_comprobante: 2, estado: 'pendiente', anulado: false, numero_formateado: 'B001-00000005' }]);

      await expect(servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO)).rejects.toMatchObject({
        status: 409,
        response: { id_comprobante: 5 },
      });
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('404 si no existe y 409 si está anulada', async () => {
      const { servicio, repo } = crear();
      repo.obtenerParaComprobante.mockResolvedValueOnce(null);
      await expect(servicio.emitirComprobanteDeVenta(99, { id_tipo: 2 } as never, USUARIO)).rejects.toBeInstanceOf(NotFoundException);

      repo.obtenerParaComprobante.mockResolvedValueOnce(ventaGuardada({ estado: 'anulada' }));
      await expect(servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO)).rejects.toBeInstanceOf(ConflictException);
    });

    it('una diferencia que no es recargo por tarjeta no se inventa: el motor responde 400 y se propaga', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.obtenerParaComprobante.mockResolvedValue(ventaGuardada({ total: 25, pagos: [{ id_metodo: EFECTIVO, monto: 25, metodo: 'Efectivo', tipo: 'efectivo' }] }));
      comprobantes.generar.mockRejectedValue(new BadRequestException('El comprobante sumaría S/ 19.60 y la venta se cobró por S/ 25.00'));

      await expect(servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO)).rejects.toBeInstanceOf(BadRequestException);
      const [solicitud, , opciones] = comprobantes.generar.mock.calls[0];
      expect(solicitud.items).toHaveLength(1);
      expect(opciones).toEqual({ totalExigido: 25 });
    });

    it('con la emisión inactiva responde la venta con el motivo y el pendiente (no es un error de la acción)', async () => {
      const { servicio, comprobantes } = crear();
      comprobantes.generar.mockRejectedValue(new ServiceUnavailableException('No se emitió el comprobante: la emisión electrónica no está activa (POS BETA apagado).'));

      const venta = await servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);

      expect(venta.comprobante).toBeUndefined();
      expect(venta.comprobante_error).toContain('no está activa');
      expect(venta.comprobante_pendiente).toBe(true);
    });

    it('receptor: el indicado en la acción o, si no, el cliente de la venta', async () => {
      const conDocumento = crear();
      await conDocumento.servicio.emitirComprobanteDeVenta(9, { id_tipo: 1, documento: '20123456789' } as never, USUARIO);
      expect(conDocumento.receptor.buscarPorDocumento).toHaveBeenCalledWith('20123456789', true);
      expect(conDocumento.comprobantes.generar.mock.calls[0][0]).toMatchObject({ id_tipo: 1, documento: '20123456789', id_empresa: 31 });

      const delCliente = crear();
      await delCliente.servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);
      expect(delCliente.receptor.porIdCliente).toHaveBeenCalledWith(17);
      expect(delCliente.comprobantes.generar.mock.calls[0][0]).toMatchObject({ documento: '45678912', id_cliente: 17 });
    });

    it('al crédito declara lo que todavía se debe con el vencimiento de la cuenta por cobrar', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.obtenerParaComprobante.mockResolvedValue(ventaGuardada({
        total: 19.6,
        pagos: [{ id_metodo: 3, monto: 19.6, metodo: 'Crédito', tipo: 'credito' }],
        credito: { monto_total: 19.6, saldo: 12.5, fecha_vencimiento: '2099-12-31', estado: 'parcial' },
      }));

      await servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);

      expect(comprobantes.generar.mock.calls[0][0]).toMatchObject({
        forma_pago: 'Credito',
        monto_credito: 12.5,
        fecha_de_vencimiento: '2099-12-31',
      });
    });

    it('un saldo al crédito ya vencido no se puede declarar como cuota futura: 400 sin emitir', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.obtenerParaComprobante.mockResolvedValue(ventaGuardada({
        total: 19.6,
        pagos: [{ id_metodo: 3, monto: 19.6, metodo: 'Crédito', tipo: 'credito' }],
        credito: { monto_total: 19.6, saldo: 19.6, fecha_vencimiento: '2020-01-01', estado: 'vencido' },
      }));

      await expect(servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO)).rejects.toBeInstanceOf(BadRequestException);
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('una línea cobrada sin IGV no se adivina (exonerada o inafecta): 400 sin emitir', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.obtenerParaComprobante.mockResolvedValue(ventaGuardada({
        total: 19.6,
        pagos: [{ id_metodo: EFECTIVO, monto: 19.6, metodo: 'Efectivo', tipo: 'efectivo' }],
        lineas: [{ ...ventaGuardada().lineas[0], subtotal: 19.6, igv: 0 }],
      }));

      await expect(servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO)).rejects.toThrow('exonerada o inafecta');
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });
  });
});

describe('VentaBussnies: anular venta (D9, la resuelve el negocio de notas de crédito)', () => {
  function crear(notasCredito?: unknown) {
    return new VentaBussnies(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, notasCredito as never,
    );
  }

  it('delega con el motivo, la verificación en SOL y el usuario del token (sin token, null)', async () => {
    const notas = { anularVenta: jest.fn().mockResolvedValue({ estado: 'anulacion_en_curso', id_venta: 9 }) };
    const dto = { motivo: 'El cliente desiste', confirmar_verificado_sol: true, existe_en_sunat: false, nota: 'No figura en SOL' };

    expect(await crear(notas).anular(9, dto, { id_usuario: 4, rol: 'admin' } as never)).toEqual({ estado: 'anulacion_en_curso', id_venta: 9 });
    await crear(notas).anular(9);

    expect(notas.anularVenta).toHaveBeenNthCalledWith(1, 9, dto, 4);
    expect(notas.anularVenta).toHaveBeenNthCalledWith(2, 9, {}, null);
  });

  it('sin el negocio de notas responde 503 con un mensaje claro y no toca nada', async () => {
    const error = await crear().anular(9).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('no está disponible');
  });
});

describe('VentaBussnies: buscarPorCodigoBarras normaliza el código', () => {
  const crear = (resultado: unknown, inactivo: unknown = null) => {
    const repo = {
      buscarPorCodigoBarras: jest.fn().mockResolvedValue(resultado),
      buscarInactivoPorCodigo: jest.fn().mockResolvedValue(inactivo),
    };
    const servicio = new VentaBussnies(
      repo as unknown as VentaRepository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { repo, servicio };
  };

  it('quita caracteres de control y espacios de los bordes antes de buscar', async () => {
    const { repo, servicio } = crear({ id_producto: 1 });
    await servicio.buscarPorCodigoBarras('  7501234567890\r\n', 3);
    expect(repo.buscarPorCodigoBarras).toHaveBeenCalledWith('7501234567890', 3);
  });

  it('conserva los símbolos legítimos del código', async () => {
    const { repo, servicio } = crear({ id_producto: 1 });
    await servicio.buscarPorCodigoBarras('\tAB/12-%3\n');
    expect(repo.buscarPorCodigoBarras).toHaveBeenCalledWith('AB/12-%3', undefined);
  });

  it('un código vacío tras limpiar responde 400 sin consultar', async () => {
    const { repo, servicio } = crear(null);
    await expect(servicio.buscarPorCodigoBarras(' \r\n ')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.buscarPorCodigoBarras).not.toHaveBeenCalled();
  });

  it('sin producto responde 404 con el código limpio', async () => {
    const { servicio } = crear(null);
    await expect(servicio.buscarPorCodigoBarras('999\r')).rejects.toThrow('No hay ningún producto con el código 999');
  });

  it('si hay un producto activo no consulta los inactivos', async () => {
    const { repo, servicio } = crear({ id_producto: 1 }, { id_producto: 2, nombre: 'X' });
    await servicio.buscarPorCodigoBarras('123');
    expect(repo.buscarInactivoPorCodigo).not.toHaveBeenCalled();
  });

  it('sin activo pero con un inactivo responde 409 PRODUCTO_INACTIVO con el nombre y el id', async () => {
    const { repo, servicio } = crear(null, { id_producto: 12, nombre: 'CLAVO 2"' });
    const error: any = await servicio.buscarPorCodigoBarras('777\r').catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      codigo: 'PRODUCTO_INACTIVO',
      id_producto: 12,
      message: 'El producto "CLAVO 2"" existe pero está inactivo',
    });
    expect(repo.buscarInactivoPorCodigo).toHaveBeenCalledWith('777');
  });

  it('sin activo ni inactivo sigue siendo 404', async () => {
    const { servicio } = crear(null, null);
    await expect(servicio.buscarPorCodigoBarras('555')).rejects.toBeInstanceOf(NotFoundException);
  });
});
