import { BadRequestException, ConflictException, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { VentaRepository } from '../../repository/Repository/venta.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { CrearVentaRequest } from '../../models/model/venta/venta.request';
import { calcularComprobante } from '../../util/fiscal/calculo-fiscal';
import { VentaBussnies } from './venta.bussnies';
import { ControlRebajaService } from '../../control-rebaja/control-rebaja.service';
import * as controlRebajaUtil from '../../util/precios/control-rebaja';
import { ForbiddenException } from '@nestjs/common';
import { LocalesUsuarioService } from '../../stock/locales-usuario.service';

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

  describe('forma de pago de la vista previa', () => {
    const CREDITO = 9;
    const conCredito = () => {
      const creado = crearServicio();
      creado.creditoRepo.metodosConTipo.mockResolvedValue([
        { id_metodo: EFECTIVO, nombre: 'Efectivo', tipo: 'efectivo' },
        { id_metodo: TARJETA, nombre: 'Tarjeta', tipo: 'tarjeta' },
        { id_metodo: CREDITO, nombre: 'Crédito', tipo: 'credito' },
      ]);
      creado.creditoRepo.idMetodoCredito.mockResolvedValue(CREDITO);
      return creado;
    };

    it('contado cuando solo hay medios al contado', async () => {
      const { servicio } = conCredito();
      const preview: any = await servicio.previsualizar(venta([{ id_metodo: EFECTIVO, monto: 19.6 }]));
      expect(preview.forma_pago).toBe('Contado');
    });

    it('crédito cuando algún medio con monto es el crédito, también en un pago mixto', async () => {
      const { servicio } = conCredito();
      const mixto: any = await servicio.previsualizar(
        venta([{ id_metodo: EFECTIVO, monto: 10 }, { id_metodo: CREDITO, monto: 9.6 }]),
      );
      expect(mixto.forma_pago).toBe('Credito');
    });

    it('crédito elegido todavía sin monto: es lo único elegido', async () => {
      const { servicio } = conCredito();
      const preview: any = await servicio.previsualizar(venta([{ id_metodo: CREDITO, monto: 0 }]));
      expect(preview.forma_pago).toBe('Credito');
    });

    it('crédito sin monto junto a un medio con monto no cuenta como crédito', async () => {
      const { servicio } = conCredito();
      const preview: any = await servicio.previsualizar(
        venta([{ id_metodo: EFECTIVO, monto: 19.6 }, { id_metodo: CREDITO, monto: 0 }]),
      );
      expect(preview.forma_pago).toBe('Contado');
    });

    it('sin medios elegidos no afirma nada ni consulta los métodos de pago', async () => {
      const { servicio, creditoRepo } = conCredito();
      const preview: any = await servicio.previsualizar(venta(undefined));
      expect(preview.forma_pago).toBeUndefined();
      expect(creditoRepo.metodosConTipo).not.toHaveBeenCalled();
    });

    it('si falla la lectura de los métodos, la vista previa sale igual sin forma de pago', async () => {
      const { servicio, creditoRepo } = conCredito();
      // La primera lectura es la del recargo de tarjeta; la segunda, la de la forma de pago.
      creditoRepo.metodosConTipo
        .mockResolvedValueOnce([{ id_metodo: EFECTIVO, nombre: 'Efectivo', tipo: 'efectivo' }])
        .mockRejectedValue(new Error('bd caída'));
      const preview: any = await servicio.previsualizar(venta([{ id_metodo: EFECTIVO, monto: 19.6 }]));
      expect(preview.forma_pago).toBeUndefined();
      expect(preview.items).toBeDefined();
    });
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
    // El mismo carrito que piden los reintentos de abajo: 1 cemento.
    items: [{ id_producto: 7, descripcion: 'CEMENTO', cantidad: 1, precio: 10 }],
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

  function crear(bitacora?: unknown) {
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
      undefined,
      bitacora as never,
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

    it('envío diferido: el comprobante en proceso NO es un error del mostrador (sin comprobante_error ni pendiente de emitir)', async () => {
      const { servicio, comprobantes } = crear();
      comprobantes.generar.mockResolvedValue({
        id_comprobante: 5, aceptada_sunat: false, estado: 'pendiente', estado_sunat: 'ENVIANDO', ambiente_fiscal: 'produccion',
        envio_diferido: true, sunat_description: 'BB01-00000005 quedó firmado y guardado; se está enviando a SUNAT.',
      });

      const venta = await servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      expect(venta.comprobante).toMatchObject({ id_comprobante: 5, estado: 'pendiente', envio_diferido: true });
      expect(venta.comprobante_error).toBeUndefined();
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

    it('la caja que manda el cliente se ignora: el repositorio elige la del cajero o la de su local', async () => {
      const { servicio, repo } = crear();

      await servicio.registrar(
        { id_tipo: 2, id_caja: 3, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      const [datos] = repo.registrar.mock.calls[0];
      expect(datos).not.toHaveProperty('id_caja');
      expect(datos.id_usuario).toBe(4);
    });

    it('descontar_stock:false solo vale para administración; el de un cajero se ignora y el stock se descuenta', async () => {
      const cajero = crear();
      await cajero.servicio.registrar(
        { id_tipo: 2, descontar_stock: false, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );
      expect(cajero.repo.registrar.mock.calls[0][3]).toMatchObject({ descontarStock: true });

      const admin = crear();
      await admin.servicio.registrar(
        { id_tipo: 2, descontar_stock: false, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        { id_usuario: 1, rol: 'admin' } as never,
      );
      expect(admin.repo.registrar.mock.calls[0][3]).toMatchObject({ descontarStock: false });
    });

    it('Fase 6.1: cada línea lleva el costo del producto al vender (null si no tiene); la vista previa no lo expone', async () => {
      const { servicio, repo, comprobantes } = crear();
      (comprobantes as any).previsualizar = jest.fn(async (solicitud: any) => ({ total: 10, items: solicitud.items }));
      repo.cargarProductos.mockResolvedValue(new Map([[7, { ...PRODUCTO, precio_compra: 7.5 }], [8, { ...PRODUCTO, id_producto: 8, precio_compra: null }]]));

      await servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }, { id_producto: 8, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 20 }] } as CrearVentaRequest,
        USUARIO,
      );

      const lineas = repo.registrar.mock.calls[0][1];
      expect(lineas.map((l: any) => l.costo_unitario)).toEqual([7.5, null]);
      const vista = await servicio.previsualizar({ id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }] } as CrearVentaRequest, USUARIO);
      const solicitud = JSON.stringify((comprobantes as any).previsualizar.mock.calls[0][0]);
      expect(solicitud).not.toContain('costo_unitario');
      expect(solicitud).not.toContain('precio_compra');
      expect(JSON.stringify(vista)).not.toContain('costo_unitario');
    });

    it('Fase 6.5: vender sin descontar stock (admin) deja la bitácora con el motivo, o «sin motivo» si el front no lo manda', async () => {
      const bitacora = dobleBitacora();
      const { servicio, repo } = crear(bitacora);
      const ADMIN = { id_usuario: 1, rol: 'admin' } as never;
      const base = { id_tipo: 2, descontar_stock: false, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] };

      await servicio.registrar({ ...base, motivo_sin_stock: '  Entrega de muestra  ' } as CrearVentaRequest, ADMIN);
      await servicio.registrar(base as CrearVentaRequest, ADMIN);

      expect(bitacora.registrar).toHaveBeenCalledTimes(2);
      expect(bitacora.registrar.mock.calls[0][0]).toMatchObject({
        accion: 'venta.sin_descontar_stock', id_usuario: 1, rol: 'admin', entidad: 'venta', id_entidad: 9, motivo: 'Entrega de muestra',
      });
      expect(bitacora.registrar.mock.calls[1][0]).toMatchObject({ motivo: 'sin motivo' });
      // Después del registro (la transacción ya terminó).
      expect(bitacora.registrar.mock.invocationCallOrder[0]).toBeGreaterThan(repo.registrar.mock.invocationCallOrder[0]);
    });

    it('Fase 6.5: ni la venta normal, ni el pedido de un cajero, ni un reintento idempotente anotan nada', async () => {
      const bitacora = dobleBitacora();
      const { servicio, repo } = crear(bitacora);
      const pedido = { id_tipo: 2, descontar_stock: false, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] };

      await servicio.registrar({ ...pedido, descontar_stock: undefined } as CrearVentaRequest, { id_usuario: 1, rol: 'admin' } as never);
      await servicio.registrar(pedido as CrearVentaRequest, USUARIO);
      repo.registrar.mockResolvedValue({ id_venta: 9, existente: true });
      await servicio.registrar(pedido as CrearVentaRequest, { id_usuario: 1, rol: 'admin' } as never);

      expect(bitacora.registrar).not.toHaveBeenCalled();
    });

    it('un error de la base (interbloqueo 40P01) sale tal cual para el filtro global, no como 400 con el texto crudo', async () => {
      const { servicio, repo } = crear();
      const driver = Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR', routine: 'DeadLockReport' });
      const interbloqueo = new QueryFailedError('UPDATE inventario SET stock = 1', [], driver);
      repo.registrar.mockRejectedValue(interbloqueo);

      const intento = servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      );

      await expect(intento).rejects.toBe(interbloqueo);
      await expect(intento).rejects.not.toBeInstanceOf(BadRequestException);
    });

    it('la caja se cerró mientras se cobraba: 409 CAJA_CERRANDO con un mensaje para volver a cobrar', async () => {
      const { servicio, repo, comprobantes } = crear();
      repo.registrar.mockRejectedValue(new Error('CAJA_CERRANDO'));

      const error = await servicio.registrar(
        { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] } as CrearVentaRequest,
        USUARIO,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        codigo: 'CAJA_CERRANDO',
        message: 'La caja se estaba cerrando en ese momento. No se registró la venta: vuelva a cobrar.',
      });
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('dos pagos con el mismo medio: 400 PAGOS_METODO_REPETIDO sin registrar nada', async () => {
      const { servicio, repo } = crear();

      const error = await servicio.registrar(
        {
          id_tipo: 2,
          items: [{ id_producto: 7, cantidad: 1 }],
          pagos: [{ id_metodo: EFECTIVO, monto: 4 }, { id_metodo: EFECTIVO, monto: 6 }],
        } as CrearVentaRequest,
        USUARIO,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toEqual({
        codigo: 'PAGOS_METODO_REPETIDO',
        message: 'Hay dos pagos con el mismo medio: júntelos en una sola línea.',
      });
      expect(repo.registrar).not.toHaveBeenCalled();
    });

    describe('misma clave de idempotencia (A6)', () => {
      // Cemento a S/ 10: el pago cuadra con el carrito para llegar hasta el registro.
      const conClave = (items: CrearVentaRequest['items']) => ({
        id_tipo: 2,
        clave_idempotencia: 'abc-1',
        items,
        pagos: [{ id_metodo: EFECTIVO, monto: 10 * items.reduce((suma, i) => suma + i.cantidad, 0) }],
      } as CrearVentaRequest);

      it('con el mismo carrito (aunque venga partido en dos líneas) devuelve la venta existente', async () => {
        const { servicio, repo } = crear();
        repo.buscarPorClaveIdempotencia.mockResolvedValue(9);

        const venta = await servicio.registrar(
          conClave([{ id_producto: 7, cantidad: 0.5 }, { id_producto: 7, cantidad: 0.5 }]),
          USUARIO,
        );

        expect(venta.id_venta).toBe(9);
        expect(repo.registrar).not.toHaveBeenCalled();
      });

      it('con otro carrito responde 409 VENTA_CLAVE_REUTILIZADA y no registra nada', async () => {
        const { servicio, repo, comprobantes } = crear();
        repo.buscarPorClaveIdempotencia.mockResolvedValue(9);

        const error = await servicio.registrar(conClave([{ id_producto: 7, cantidad: 2 }]), USUARIO).catch((e) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toEqual({
          codigo: 'VENTA_CLAVE_REUTILIZADA',
          id_venta: 9,
          message: 'Esta venta ya se había registrado (venta N.º 9 por S/ 20.19) con otros productos. No se registró de nuevo: revísela en Ventas y, si falta algo, cóbrelo como una venta nueva.',
        });
        expect(repo.registrar).not.toHaveBeenCalled();
        expect(comprobantes.generar).not.toHaveBeenCalled();
      });

      it('también cuando la venta existente la detecta el repositorio o la carrera del índice único', async () => {
        const enRepo = crear();
        enRepo.repo.registrar.mockResolvedValue({ id_venta: 9, existente: true });
        await expect(enRepo.servicio.registrar(conClave([{ id_producto: 7, cantidad: 4 }]), USUARIO))
          .rejects.toBeInstanceOf(ConflictException);

        const carrera = crear();
        carrera.repo.registrar.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
        carrera.repo.buscarPorClaveIdempotencia.mockResolvedValueOnce(null).mockResolvedValueOnce(9);
        const error = await carrera.servicio.registrar(conClave([{ id_producto: 7, cantidad: 3 }]), USUARIO).catch((e) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toMatchObject({ codigo: 'VENTA_CLAVE_REUTILIZADA', id_venta: 9 });
      });
    });
  });

  describe('emitirComprobanteDeVenta', () => {
    it('usa las líneas guardadas tal como se cobraron, agrega el recargo por tarjeta y exige el total exacto', async () => {
      const { servicio, comprobantes } = crear();

      const venta = await servicio.emitirComprobanteDeVenta(9, { id_tipo: 2 } as never, USUARIO);

      const [solicitud, idUsuario, opciones] = comprobantes.generar.mock.calls[0];
      expect(idUsuario).toBe(4);
      expect(opciones).toMatchObject({ totalExigido: 20.19 });
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
      expect(opciones).toMatchObject({ totalExigido: 25 });
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

    expect(notas.anularVenta).toHaveBeenNthCalledWith(1, 9, dto, 4, 'admin');
    expect(notas.anularVenta).toHaveBeenNthCalledWith(2, 9, {}, null, null);
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


describe('VentaBussnies: control de rebajas y permiso de autorización (Fase 6.4, 6.6)', () => {
  /** Cemento: S/ 10 en la base, sin descuento, costo S/ 7.50. */
  const CEMENTO = {
    id_producto: 7,
    nombre: 'CEMENTO',
    precio_venta: 10,
    descuento: 0,
    sku: 'CEM-01',
    codigo_barras: '',
    unidad_medida: 'NIU',
    stock_disponible: 50,
    reglas_mayoristas: [],
    precio_compra: 7.5,
  };
  const VENDEDOR = { id_usuario: 4, nombre: 'Rosa', rol: 'vendedor' } as never;
  const ADMIN = { id_usuario: 1, nombre: 'Dueño', rol: 'admin' } as never;

  function crear(opciones: { valores?: Record<string, string | null>; configFalla?: boolean; conControl?: boolean } = {}) {
    const repo = {
      cargarProductos: jest.fn().mockResolvedValue(new Map([[7, CEMENTO]])),
      registrar: jest.fn().mockResolvedValue({ id_venta: 9, existente: false }),
      obtener: jest.fn().mockResolvedValue({ id_venta: 9, fecha: new Date('2026-11-25T15:00:00Z'), origen: 'mostrador', subtotal: 0, igv: 0, total: 0, items: [{ id_producto: 7, cantidad: 1 }], pagos: [] }),
      buscarPorClaveIdempotencia: jest.fn().mockResolvedValue(null),
      listarAlmacenesPos: jest.fn().mockResolvedValue([]),
    };
    const config = {
      obtenerNumero: jest.fn(async (clave: string, defecto: number) => (clave === 'tienda_igv_porcentaje' ? 18 : defecto)),
      obtener: jest.fn().mockResolvedValue(null),
      obtenerVarias: jest.fn(async (claves: string[]) => {
        if (opciones.configFalla) throw new Error('sin conexión');
        return Object.fromEntries(claves.map((c) => [c, opciones.valores?.[c] ?? null]));
      }),
      guardar: jest.fn(),
    };
    const comprobantes = {
      previsualizar: jest.fn(async (solicitud: any) => ({ total: 0, items: solicitud.items })),
      generar: jest.fn().mockResolvedValue({ id_comprobante: 5, tipo_de_comprobante: 2, aceptada_sunat: true, estado: 'emitido' }),
      listarPorVenta: jest.fn().mockResolvedValue([]),
    };
    const receptor = {
      consumidorFinal: jest.fn().mockResolvedValue({ origen: 'generico', tipo_documento: 1, numero_documento: '00000000', denominacion: 'CLIENTES VARIOS' }),
    };
    const creditoRepo = {
      metodosConTipo: jest.fn().mockResolvedValue([{ id_metodo: 1, nombre: 'Efectivo', tipo: 'efectivo' }]),
      idMetodoCredito: jest.fn().mockResolvedValue(null),
    };
    const cajaSesion = { configEstricto: jest.fn().mockResolvedValue({ modo: 'blando', bypassAdmin: false }) };
    const bitacora = dobleBitacora();
    const control = new ControlRebajaService(config as never, { query: jest.fn() } as never, bitacora as never);
    const servicio = new VentaBussnies(
      repo as unknown as VentaRepository,
      config as unknown as ConfiguracionRepository,
      comprobantes as unknown as ComprobanteBussnies,
      receptor as never,
      creditoRepo as never,
      {} as never,
      {} as never,
      cajaSesion as never,
      undefined,
      bitacora as never,
      opciones.conControl === false ? undefined : control,
    );
    return { servicio, repo, comprobantes, receptor, bitacora, control, config };
  }

  const AUTORIZAR = { control_rebaja_modo: 'autorizar' };
  /** Una venta de `cantidad` cementos a `precio` cada uno (sin pagos: se toma el total). */
  const venta = (precio: number, extra: Partial<CrearVentaRequest> = {}, cantidad = 1) =>
    ({ id_tipo: 2, items: [{ id_producto: 7, cantidad, precio_unitario: precio }], ...extra }) as CrearVentaRequest;
  const acciones = (bitacora: ReturnType<typeof dobleBitacora>) => bitacora.registrar.mock.calls.map((c) => c[0].accion);

  describe('modo registrar (por defecto, sin claves)', () => {
    it('la venta con 20 % de rebaja PASA y, después del COMMIT, deja una fila con vendedor, producto, referencia y cobrado', async () => {
      const { servicio, repo, bitacora } = crear();

      const respuesta = await servicio.registrar(venta(8, { id_almacen: 3 }), VENDEDOR);

      expect(respuesta.id_venta).toBe(9);
      expect(repo.registrar).toHaveBeenCalledTimes(1);
      expect(bitacora.registrar).toHaveBeenCalledTimes(1);
      expect(bitacora.registrar.mock.calls[0][0]).toEqual({
        accion: 'venta.rebaja_sobre_tope',
        id_usuario: 4,
        rol: 'vendedor',
        id_autorizador: null,
        id_almacen: 3,
        entidad: 'venta',
        id_entidad: 9,
        despues: { id_producto: 7, descripcion: 'CEMENTO', cantidad: 1, precio_referencia: 10, precio_cobrado: 8, rebaja_pct: 20, tope_pct: 10, modo: 'registrar' },
      });
      expect(bitacora.registrarCon.mock.invocationCallOrder[0]).toBeGreaterThan(repo.registrar.mock.invocationCallOrder[0]);
    });

    it('por debajo del costo: también la fila venta.bajo_costo, con el costo (la bitácora es solo de admin)', async () => {
      const { servicio, bitacora } = crear();
      await servicio.registrar(venta(7), VENDEDOR);
      expect(acciones(bitacora)).toEqual(['venta.rebaja_sobre_tope', 'venta.bajo_costo']);
      expect(bitacora.registrar.mock.calls[1][0].despues).toMatchObject({ precio_cobrado: 7, costo_unitario: 7.5 });
    });

    it('dentro del tope, al precio de lista o más caro: no anota nada', async () => {
      const { servicio, bitacora } = crear();
      await servicio.registrar(venta(9), VENDEDOR);
      await servicio.registrar(venta(10), VENDEDOR);
      await servicio.registrar(venta(12), VENDEDOR);
      expect(bitacora.registrar).not.toHaveBeenCalled();
    });

    it('un permiso inválido que sobre no molesta: en registrar no se mira', async () => {
      const { servicio, repo } = crear();
      await servicio.registrar(venta(5, { permiso_autorizacion: 'basura.total' }), VENDEDOR);
      expect(repo.registrar).toHaveBeenCalledTimes(1);
    });
  });

  describe('exentos, apagado y fallos: ninguna venta que hoy pasa deja de pasar', () => {
    it('admin, cotización convertida (id_proforma) y control apagado: pasan sin evaluar ni anotar, aun en autorizar', async () => {
      const admin = crear({ valores: AUTORIZAR });
      await admin.servicio.registrar(venta(5), ADMIN);
      const cotizacion = crear({ valores: AUTORIZAR });
      await cotizacion.servicio.registrar(venta(5, { id_proforma: 33 }), VENDEDOR);
      const apagado = crear({ valores: { control_rebaja_modo: 'apagado' } });
      await apagado.servicio.registrar(venta(5), VENDEDOR);

      for (const caso of [admin, cotizacion, apagado]) {
        expect(caso.repo.registrar).toHaveBeenCalledTimes(1);
        expect(caso.bitacora.registrar).not.toHaveBeenCalled();
      }
    });

    // La cotización fija el precio neto y el repositorio compara solo el precio de LISTA: la exención no
    // puede alcanzar a una venta que además trae rebaja propia.
    describe('cotización y rebaja propia', () => {
      const conRebaja = (descuento?: number) => ({
        id_tipo: 2,
        id_proforma: 33,
        items: [{ id_producto: 7, cantidad: 1, precio_unitario: 10, ...(descuento === undefined ? {} : { descuento }) }],
      }) as CrearVentaRequest;

      it('descuento 0 (lo que manda el POS): exenta, aun en autorizar', async () => {
        const { servicio, repo, bitacora } = crear({ valores: AUTORIZAR });
        await servicio.registrar(conRebaja(0), VENDEDOR);
        expect(repo.registrar).toHaveBeenCalledTimes(1);
        expect(bitacora.registrar).not.toHaveBeenCalled();
      });

      it('descuento > 0: se evalúa como cualquier venta y pide autorización', async () => {
        const { servicio, repo } = crear({ valores: AUTORIZAR });
        await expect(servicio.registrar(conRebaja(9.99), VENDEDOR)).rejects.toMatchObject({ status: 409 });
        expect(repo.registrar).not.toHaveBeenCalled();
      });

      it('descuento omitido con un producto que tiene descuento de ficha: se evalúa', async () => {
        const { servicio, repo, bitacora } = crear();
        repo.cargarProductos.mockResolvedValue(new Map([[7, { ...CEMENTO, descuento: 2, precio_compra: 9 }]]));
        await servicio.registrar(conRebaja(undefined), VENDEDOR);
        // Referencia 8 (10 − 2) y costo 9: queda bajo el costo y se anota; antes salía exenta.
        expect(repo.registrar).toHaveBeenCalledTimes(1);
        expect(acciones(bitacora)).toContain('venta.bajo_costo');
      });
    });

    it('si leer la configuración falla, la venta sigue como hoy (sin control) y queda un aviso en el log', async () => {
      const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { servicio, repo, bitacora } = crear({ configFalla: true });
      await servicio.registrar(venta(5), VENDEDOR);
      expect(repo.registrar).toHaveBeenCalledTimes(1);
      expect(bitacora.registrar).not.toHaveBeenCalled();
      expect(aviso).toHaveBeenCalledWith(expect.stringContaining('la venta sigue sin control'));
      aviso.mockRestore();
    });

    it('si evaluar la rebaja lanza, la venta sigue igual (aun en autorizar) y queda un aviso en el log', async () => {
      const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const evaluar = jest.spyOn(controlRebajaUtil, 'evaluarRebajas').mockImplementation(() => {
        throw new TypeError('dato inesperado');
      });
      const { servicio, repo } = crear({ valores: AUTORIZAR });
      await servicio.registrar(venta(5), VENDEDOR);
      expect(evaluar).toHaveBeenCalled();
      expect(repo.registrar).toHaveBeenCalledTimes(1);
      expect(aviso).toHaveBeenCalledWith(expect.stringContaining('No se pudo evaluar el control de rebajas'));
      evaluar.mockRestore();
      aviso.mockRestore();
    });

    it('sin el servicio de control (inyección opcional), la venta funciona como antes', async () => {
      const { servicio, repo } = crear({ conControl: false });
      await servicio.registrar(venta(5), VENDEDOR);
      expect(repo.registrar).toHaveBeenCalledTimes(1);
    });
  });

  describe('modo autorizar', () => {
    it('sin permiso: 409 REQUIERE_AUTORIZACION con mensaje y detalle por línea, SIN el costo, y sin ningún efecto', async () => {
      const { servicio, repo, receptor, comprobantes } = crear({ valores: AUTORIZAR });

      const error = await servicio.registrar(venta(7), VENDEDOR).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getStatus()).toBe(409);
      const cuerpo = error.getResponse();
      expect(cuerpo).toEqual({
        codigo: 'REQUIERE_AUTORIZACION',
        message: 'Esta rebaja necesita la autorización de un administrador: CEMENTO (S/ 7.00 en vez de S/ 10.00: 30% de rebaja, el tope es 10%; por debajo del costo).',
        motivo: 'ausente',
        tope_pct: 10,
        lineas: [{
          indice: 0, id_producto: 7, descripcion: 'CEMENTO', cantidad: 1, precio_referencia: 10, precio_final: 7,
          rebaja_pct: 30, tope_pct: 10, sobre_tope: true, bajo_costo: true, requiere_autorizacion: true,
        }],
      });
      expect(JSON.stringify(cuerpo)).not.toContain('7.5');
      expect(repo.registrar).not.toHaveBeenCalled();
      expect(receptor.consumidorFinal).not.toHaveBeenCalled();
      expect(comprobantes.generar).not.toHaveBeenCalled();
    });

    it('dentro del tope y sobre el costo no pide nada', async () => {
      const { servicio, repo } = crear({ valores: AUTORIZAR });
      await servicio.registrar(venta(9), VENDEDOR);
      expect(repo.registrar).toHaveBeenCalledTimes(1);
    });

    it('con el permiso de un admin: pasa, anota cada línea con el autorizador y venta.autorizada; el permiso no sirve para otra venta', async () => {
      const { servicio, repo, bitacora, control } = crear({ valores: AUTORIZAR });
      jest.spyOn(control, 'verificarAdministrador').mockResolvedValue({ id_usuario: 1, nombre: 'Dueño' });

      const autorizacion = await servicio.autorizar({ email: 'dueno@x.pe', password: 'x', items: venta(7).items }, VENDEDOR);
      expect(autorizacion).toMatchObject({ vigencia_seg: 300, autorizador: { id_usuario: 1, nombre: 'Dueño' } });
      // El freno fino recibe al solicitante (el vendedor de la sesión).
      expect(control.verificarAdministrador).toHaveBeenCalledWith('dueno@x.pe', 'x', 4);
      expect(autorizacion.rebajas).toHaveLength(1);
      expect(JSON.stringify(autorizacion)).not.toContain('7.5');

      await servicio.registrar(venta(7, { clave_idempotencia: 'k-1', permiso_autorizacion: autorizacion.permiso }), VENDEDOR);

      expect(repo.registrar).toHaveBeenCalledTimes(1);
      expect(acciones(bitacora)).toEqual(['venta.rebaja_sobre_tope', 'venta.bajo_costo', 'venta.autorizada']);
      expect(bitacora.registrar.mock.calls.every((c) => c[0].id_autorizador === 1 && c[0].id_usuario === 4)).toBe(true);
      expect(bitacora.registrar.mock.calls[2][0].despues).toMatchObject({ id_solicitante: 4, id_autorizador: 1, lineas: [{ id_producto: 7, precio_cobrado: 7 }] });

      // Otra venta (otra clave) con el mismo permiso: ya se usó.
      const otra = await servicio.registrar(venta(7, { clave_idempotencia: 'k-2', permiso_autorizacion: autorizacion.permiso }), VENDEDOR).catch((e) => e);
      expect(otra.getResponse()).toMatchObject({ codigo: 'REQUIERE_AUTORIZACION', motivo: 'usado' });
    });

    it('el permiso no sirve si cambió la cantidad o el precio, ni para otro vendedor', async () => {
      const { servicio, control } = crear({ valores: AUTORIZAR });
      jest.spyOn(control, 'verificarAdministrador').mockResolvedValue({ id_usuario: 1, nombre: 'Dueño' });
      const { permiso } = await servicio.autorizar({ email: 'd@x.pe', password: 'x', items: venta(7).items }, VENDEDOR);

      const masCantidad = await servicio.registrar(venta(7, { permiso_autorizacion: permiso }, 2), VENDEDOR).catch((e) => e);
      expect(masCantidad.getResponse()).toMatchObject({ codigo: 'REQUIERE_AUTORIZACION', motivo: 'otras_lineas' });
      const otroPrecio = await servicio.registrar(venta(6.5, { permiso_autorizacion: permiso }), VENDEDOR).catch((e) => e);
      expect(otroPrecio.getResponse()).toMatchObject({ motivo: 'otras_lineas' });
      const otroVendedor = await servicio.registrar(venta(7, { permiso_autorizacion: permiso }), { id_usuario: 5, rol: 'caja' } as never).catch((e) => e);
      expect(otroVendedor.getResponse()).toMatchObject({ motivo: 'otro_solicitante' });
      expect(otroVendedor.getResponse().message).toContain('La autorización es para otro usuario');
    });

    it('vencido: 409 que lo dice', async () => {
      const { servicio, control } = crear({ valores: AUTORIZAR });
      jest.spyOn(control, 'verificarAdministrador').mockResolvedValue({ id_usuario: 1, nombre: 'Dueño' });
      control.ahora = () => 1_000_000;
      const { permiso } = await servicio.autorizar({ email: 'd@x.pe', password: 'x', items: venta(7).items }, VENDEDOR);
      control.ahora = () => 1_000_000 + 300_000;
      const error = await servicio.registrar(venta(7, { permiso_autorizacion: permiso }), VENDEDOR).catch((e) => e);
      expect(error.getResponse()).toMatchObject({ motivo: 'vencido' });
      expect(error.getResponse().message).toContain('venció');
    });

    it('el reintento idempotente va PRIMERO: con la venta ya registrada se devuelve sin mirar permiso (aunque falte o esté vencido)', async () => {
      const { servicio, repo, control } = crear({ valores: AUTORIZAR });
      const verificar = jest.spyOn(control, 'verificarPermiso');
      repo.buscarPorClaveIdempotencia.mockResolvedValue(9);

      const respuesta = await servicio.registrar(venta(7, { clave_idempotencia: 'k-1' }), VENDEDOR);

      expect(respuesta.id_venta).toBe(9);
      expect(verificar).not.toHaveBeenCalled();
      expect(repo.cargarProductos).not.toHaveBeenCalled();
      expect(repo.registrar).not.toHaveBeenCalled();
    });

    it('credenciales malas: el 422 sale tal cual y no hay permiso', async () => {
      const { servicio, control } = crear({ valores: AUTORIZAR });
      jest.spyOn(control, 'verificarAdministrador').mockRejectedValue(new UnprocessableEntityException({ codigo: 'AUTORIZACION_RECHAZADA', message: 'x' }));
      const emitir = jest.spyOn(control, 'emitirPermiso');
      await expect(servicio.autorizar({ email: 'd@x.pe', password: 'mala', items: venta(7).items }, VENDEDOR)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(emitir).not.toHaveBeenCalled();
    });

    it('autorizar sin líneas: 400 antes de mirar la contraseña', async () => {
      const { servicio, control } = crear({ valores: AUTORIZAR });
      const verificar = jest.spyOn(control, 'verificarAdministrador');
      await expect(servicio.autorizar({ email: 'd@x.pe', password: 'x', items: [] }, VENDEDOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(verificar).not.toHaveBeenCalled();
    });
  });

  describe('vista previa y contexto del POS', () => {
    it('la vista previa trae `rebajas` (sin costo) para el vendedor; para admin no la trae', async () => {
      const { servicio } = crear({ valores: AUTORIZAR });
      const vista = await servicio.previsualizar(venta(7), VENDEDOR);
      expect(vista.rebajas).toEqual([expect.objectContaining({ id_producto: 7, sobre_tope: true, bajo_costo: true, requiere_autorizacion: true })]);
      expect(JSON.stringify(vista.rebajas)).not.toContain('7.5');
      // Solo la señal «bajo_costo»: ni el valor ni el campo del costo.
      expect(JSON.stringify(vista)).not.toMatch(/costo_unitario|precio_compra|7\.5/);

      const deAdmin = await servicio.previsualizar(venta(7), ADMIN);
      expect(deAdmin.rebajas).toBeUndefined();
    });

    it('contexto-pos añade modo, tope y si aplica a quien vende; si no se puede leer, no lo añade', async () => {
      const { servicio } = crear({ valores: { ...AUTORIZAR, rebaja_max_pct_vendedor: '12' } });
      await expect(servicio.contextoPos(VENDEDOR)).resolves.toMatchObject({
        control_rebaja: { modo: 'autorizar', tope_pct: 12, bajo_costo: true, aplica: true },
      });
      await expect(servicio.contextoPos(ADMIN)).resolves.toMatchObject({ control_rebaja: { aplica: false } });

      const falla = crear({ configFalla: true });
      const contexto = await falla.servicio.contextoPos(VENDEDOR);
      expect(contexto).not.toHaveProperty('control_rebaja');
      expect(contexto).toHaveProperty('recargo_tarjeta_pct', 0);
    });
  });

  it('precio_referencia de cada línea: siempre que haya referencia (también admin, cotización y apagado); null sin precio en la base', async () => {
    const casos: [ReturnType<typeof crear>, CrearVentaRequest, unknown][] = [
      [crear(), venta(7), VENDEDOR],
      [crear({ valores: { control_rebaja_modo: 'apagado' } }), venta(7), VENDEDOR],
      [crear({ valores: AUTORIZAR }), venta(7), ADMIN],
      [crear({ valores: AUTORIZAR }), venta(7, { id_proforma: 33 }), VENDEDOR],
    ];
    for (const [caso, cuerpo, usuario] of casos) {
      await caso.servicio.registrar(cuerpo, usuario as never);
      expect(caso.repo.registrar.mock.calls[0][1][0]).toMatchObject({ precio_unitario_final: 7, precio_referencia: 10 });
    }
    // Regla mayorista de esa cantidad: la referencia es el precio neto de la regla.
    const mayorista = crear({ valores: { control_rebaja_modo: 'apagado' } });
    mayorista.repo.cargarProductos.mockResolvedValue(new Map([[7, { ...CEMENTO, reglas_mayoristas: [{ id_regla: 1, cantidad_minima: 10, descuento_unitario: 1 }] }]]));
    await mayorista.servicio.registrar(venta(10, {}, 12), VENDEDOR);
    expect(mayorista.repo.registrar.mock.calls[0][1][0]).toMatchObject({ precio_referencia: 9 });

    const sinPrecio = crear();
    sinPrecio.repo.cargarProductos.mockResolvedValue(new Map([[7, { ...CEMENTO, precio_venta: 0 }]]));
    await sinPrecio.servicio.registrar(venta(7), VENDEDOR);
    expect(sinPrecio.repo.registrar.mock.calls[0][1][0].precio_referencia).toBeNull();
  });

  it('si calcular la referencia falla, la línea va con null y la venta sigue', async () => {
    const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const referencia = jest.spyOn(controlRebajaUtil, 'precioReferencia').mockImplementation(() => {
      throw new TypeError('dato inesperado');
    });
    const { servicio, repo } = crear({ conControl: false });
    await servicio.registrar(venta(10), VENDEDOR);
    expect(repo.registrar).toHaveBeenCalledTimes(1);
    expect(repo.registrar.mock.calls[0][1][0].precio_referencia).toBeNull();
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('precio de referencia'));
    referencia.mockRestore();
    aviso.mockRestore();
  });

  it('6.6: el tipo de IGV que manda el navegador se ignora; la venta y el comprobante van gravados', async () => {
    const { servicio, repo, comprobantes } = crear({ valores: { control_rebaja_modo: 'apagado' } });

    await servicio.registrar(
      { id_tipo: 2, items: [{ id_producto: 7, cantidad: 1, tipo_de_igv: 8 }] } as CrearVentaRequest,
      VENDEDOR,
    );

    const [datos, lineas] = repo.registrar.mock.calls[0];
    expect(datos.igv).toBeGreaterThan(0);
    expect(lineas[0].igv).toBeGreaterThan(0);
    expect(comprobantes.generar.mock.calls[0][0].items[0].tipo_de_igv).toBe(1);
  });
});


/** Doble de BitacoraService: `registrarCon` arma el evento (como el servicio real) y lo pasa a `registrar`, que es lo que miran las pruebas. */
function dobleBitacora() {
  const registrar = jest.fn(async (_evento: any) => undefined);
  const registrarCon = jest.fn(async (fabrica: () => any) => {
    const r = fabrica();
    for (const e of Array.isArray(r) ? r : [r]) if (e) await registrar(e);
  });
  return { registrar, registrarCon };
}

describe('VentaBussnies · usuarios por local (Fase 8.5)', () => {
  function crearConLocales(asignados: number[] | null) {
    const repo = {
      listarAlmacenesPos: jest.fn().mockResolvedValue([
        { id_almacen: 1, nombre: 'Principal', sucursal: 'Local A', id_sucursal: 1 },
        { id_almacen: 2, nombre: 'Anexo', sucursal: 'Local B', id_sucursal: 2 },
      ]),
      registrar: jest.fn(),
      buscarPorClaveIdempotencia: jest.fn().mockResolvedValue(null),
    };
    const config = {
      obtener: jest.fn(async (clave: string) => (clave === 'tienda_id_almacen' ? '2' : null)),
      obtenerNumero: jest.fn(async (_c: string, defecto: number) => defecto),
    };
    const receptor = { consumidorFinal: jest.fn() };
    const cajaSesion = { configEstricto: jest.fn().mockResolvedValue({ modo: 'blando', bypassAdmin: false }) };
    const repoLocales = {
      almacenesPermitidos: jest.fn(async () => asignados),
      almacen: jest.fn(async () => ({ nombre: 'Anexo', sucursal: 'Local B' })),
    };
    const locales = new LocalesUsuarioService(repoLocales as never, { tiene: async () => true } as never);
    const servicio = new VentaBussnies(
      repo as never, config as never, {} as never, receptor as never, {} as never, {} as never, {} as never, cajaSesion as never,
      undefined, undefined, undefined, locales,
    );
    return { servicio, repo, receptor };
  }
  const VENDEDOR_LOCAL = { id_usuario: 7, rol: 'vendedor' } as never;

  it('contexto-pos: un vendedor del local A solo ve su almacén y su almacén por defecto; sin asignar ve todos como hoy', async () => {
    const asignado = await crearConLocales([1]).servicio.contextoPos(VENDEDOR_LOCAL);
    expect(asignado.almacenes.map((a) => a.id_almacen)).toEqual([1]);
    expect(asignado).toMatchObject({ almacen_default: 1, locales_restringidos: true });

    const libre = await crearConLocales(null).servicio.contextoPos(VENDEDOR_LOCAL);
    expect(libre.almacenes.map((a) => a.id_almacen)).toEqual([1, 2]);
    expect(libre.almacen_default).toBe(2);
    expect(libre).not.toHaveProperty('locales_restringidos');
  });

  it('vender desde un almacén de otro local → 403 antes de cualquier efecto (ni cliente ni venta)', async () => {
    const { servicio, repo, receptor } = crearConLocales([1]);

    const error = await servicio
      .registrar({ id_tipo: 2, id_almacen: 2, items: [{ id_producto: 7, cantidad: 1 }] } as CrearVentaRequest, VENDEDOR_LOCAL)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ codigo: 'ALMACEN_FUERA_DE_SUS_LOCALES', id_almacen: 2 });
    expect(repo.registrar).not.toHaveBeenCalled();
    expect(receptor.consumidorFinal).not.toHaveBeenCalled();
  });
});

describe('VentaBussnies · bloqueo de crédito por mora (Fase 9.4)', () => {
  const CREDITO = 9;
  const MORA = { cuentas: 2, deuda_vencida: 120, vencida_desde: '2026-10-01', dias_atraso: 55 };

  function armarMora(dias: number, mora: any = MORA) {
    const creditoRepo = {
      metodosConTipo: jest.fn().mockResolvedValue([{ id_metodo: CREDITO, nombre: 'Crédito', tipo: 'credito' }]),
      idMetodoCredito: jest.fn().mockResolvedValue(CREDITO),
      lineaCliente: jest.fn().mockResolvedValue({
        credito_activo: true, limite_credito: 1000, dias_credito: 15, saldo_pendiente: 120, disponible: 880, denominacion: 'JUAN PEREZ',
      }),
      lineaEmpresa: jest.fn(),
      moraVencida: jest.fn().mockResolvedValue(mora),
    };
    const credito = { assertPuedeDarCredito: jest.fn() };
    const controlCaja = { diasBloqueoMora: jest.fn().mockResolvedValue(dias) };
    const servicio = new VentaBussnies(
      {} as never, {} as never, {} as never, {} as never, creditoRepo as never, credito as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, controlCaja as never,
    );
    const validar = (rol: string) => (servicio as any).validarPagosYCredito(
      { pagos: [{ id_metodo: CREDITO, monto: 50 }] }, 50, { id_cliente: 7, numero_documento: '44556677' }, { id_usuario: 3, rol },
    );
    return { servicio, creditoRepo, controlCaja, validar };
  }

  it('apagado (0, el valor por defecto): ni consulta la deuda y el crédito pasa como hoy', async () => {
    const { creditoRepo, validar } = armarMora(0);
    const r = await validar('caja');
    expect(r.credito).toMatchObject({ monto: 50, id_cliente: 7 });
    expect(r.moraOmitida).toBeUndefined();
    expect(creditoRepo.moraVencida).not.toHaveBeenCalled();
  });

  it('encendido con deuda vencida más allá de los días: 409 CREDITO_BLOQUEADO_POR_MORA con cuánto y desde cuándo', async () => {
    const { creditoRepo, validar } = armarMora(30);
    const error: any = await validar('caja').catch((e: unknown) => e);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ codigo: 'CREDITO_BLOQUEADO_POR_MORA', deuda_vencida: 120, vencida_desde: '2026-10-01', dias_gracia: 30 });
    expect(error.getResponse().message).toContain('S/ 120.00 vencidos desde el 01/10/2026');
    expect(creditoRepo.moraVencida).toHaveBeenCalledWith({ id_cliente: 7 }, 30);
  });

  it('el admin pasa igual y la mora vuelve para anotarla en la bitácora', async () => {
    const { validar } = armarMora(30);
    const r = await validar('admin');
    expect(r.credito).toMatchObject({ monto: 50 });
    expect(r.moraOmitida).toEqual({ ...MORA, dias_gracia: 30 });
  });

  it('sin deuda vencida pasa; si la consulta falla, la venta sigue (no deja la caja parada)', async () => {
    const sinMora = armarMora(30, null);
    await expect(sinMora.validar('caja')).resolves.toMatchObject({ credito: { monto: 50 } });
    const falla = armarMora(30);
    falla.creditoRepo.moraVencida.mockRejectedValue(new Error('bd'));
    await expect(falla.validar('caja')).resolves.toMatchObject({ credito: { monto: 50 } });
  });

  it('venta al contado: nunca mira la mora', async () => {
    const { servicio, controlCaja } = armarMora(30);
    controlCaja.diasBloqueoMora.mockClear();
    const creditoRepo = (servicio as any).creditoRepo;
    creditoRepo.metodosConTipo.mockResolvedValue([{ id_metodo: 1, nombre: 'Efectivo', tipo: 'efectivo' }]);
    creditoRepo.idMetodoCredito.mockResolvedValue(null);
    await (servicio as any).validarPagosYCredito({ pagos: [{ id_metodo: 1, monto: 50 }] }, 50, { id_cliente: 7 }, { rol: 'caja' });
    expect(controlCaja.diasBloqueoMora).not.toHaveBeenCalled();
  });
});
