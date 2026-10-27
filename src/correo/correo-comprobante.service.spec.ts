import { BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CorreoComprobanteService } from './correo-comprobante.service';
import { ErrorEnvioCorreo } from './enviador-correo.contrato';

function detalle(cambios: Record<string, unknown> = {}) {
  return {
    id_comprobante: 20,
    tipo_nombre: 'Boleta electrónica',
    numero_formateado: 'B001-00000012',
    fecha_de_emision: '2026-10-27',
    totales: { total: 118 },
    moneda: { simbolo: 'S/', nombre: 'Soles' },
    receptor: { denominacion: 'Ana', email: 'ana@ejemplo.pe' },
    emisor: { razon_social: 'HATUNSALES S.A.C.', ruc: '20610206337' },
    proveedor_fiscal: 'sunat_directo',
    ambiente_fiscal: 'produccion',
    estado_sunat: 'ACEPTADO',
    anulado: false,
    enviar_cliente: true,
    ...cambios,
  };
}

function fila(cambios: Record<string, unknown> = {}) {
  return {
    id_correo: 5, id_comprobante: 20, destino: 'ana@ejemplo.pe', estado: 'ENVIANDO', origen: 'automatico', intentos: 1,
    ultimo_error: null, motivo_omision: null, enviado_en: null, ...cambios,
  };
}

function montar() {
  const repo = {
    tablaDisponible: jest.fn(async () => true),
    reclamar: jest.fn(async () => fila()),
    marcarEnviado: jest.fn(async () => undefined),
    marcarError: jest.fn(async () => undefined),
    marcarOmitido: jest.fn(async () => undefined),
    reenviosUltimaHora: jest.fn(async () => 0),
    crearManual: jest.fn(async () => 31),
    obtener: jest.fn(async () => fila({ id_correo: 31, estado: 'ENVIADO', origen: 'manual' })),
    ultimo: jest.fn(async () => null as unknown),
    historial: jest.fn(async () => []),
  };
  const comprobantes = {
    obtenerDetalle: jest.fn(async () => detalle()),
    obtenerPdf: jest.fn(async () => ({ nombre: 'B001-00000012.pdf', contenido: Buffer.from('PDF') })),
    obtenerArchivo: jest.fn(async () => ({ nombre: 'B001.xml', mime: 'application/xml', contenido: Buffer.from('<xml/>') })),
  };
  const config = { leer: jest.fn(async () => ({ correo_envio_activo: 'true' })) };
  const enviador = { nombre: 'falso', enviar: jest.fn(async () => ({ id_mensaje: 'msg-1' })) };
  const servicio = new CorreoComprobanteService(repo as any, comprobantes as any, config as any, enviador as any);
  return { servicio, repo, comprobantes, config, enviador };
}

describe('CorreoComprobanteService', () => {
  const entorno = { ...process.env };
  afterEach(() => {
    process.env = { ...entorno };
  });

  it('activo() está apagado por defecto y solo con «true» se enciende', async () => {
    const { servicio, config } = montar();
    expect(await servicio.activo()).toBe(true);
    config.leer.mockResolvedValueOnce({ correo_envio_activo: null } as any);
    expect(await servicio.activo()).toBe(false);
    config.leer.mockResolvedValueOnce({ correo_envio_activo: 'false' });
    expect(await servicio.activo()).toBe(false);
  });

  it('procesar envía el PDF y el XML al cliente y marca ENVIADO', async () => {
    const { servicio, repo, enviador } = montar();
    expect(await servicio.procesar(5)).toBe('ENVIADO');
    const mensaje = (enviador.enviar.mock.calls as any[][])[0][0];
    expect(mensaje.para).toBe('ana@ejemplo.pe');
    expect(mensaje.asunto).toBe('Boleta electrónica B001-00000012 – HATUNSALES S.A.C.');
    expect(mensaje.adjuntos.map((a: any) => a.nombre)).toEqual(['B001-00000012.pdf', 'B001.xml']);
    expect(repo.marcarEnviado).toHaveBeenCalledWith(5, 'msg-1', null);
  });

  it('procesar devuelve null si otra réplica reclamó el correo', async () => {
    const { servicio, repo, enviador } = montar();
    repo.reclamar.mockResolvedValueOnce(null as any);
    expect(await servicio.procesar(5)).toBeNull();
    expect(enviador.enviar).not.toHaveBeenCalled();
  });

  it('sin XML firmado envía solo el PDF', async () => {
    const { servicio, comprobantes, enviador } = montar();
    comprobantes.obtenerArchivo.mockRejectedValueOnce(new NotFoundException('sin xml'));
    expect(await servicio.procesar(5)).toBe('ENVIADO');
    expect((enviador.enviar.mock.calls as any[][])[0][0].adjuntos).toHaveLength(1);
  });

  it('BETA con CORREO_DESTINO_PRUEBAS escribe solo a esa dirección, con prefijo de prueba, y la deja registrada', async () => {
    const { servicio, comprobantes, repo, enviador } = montar();
    process.env.CORREO_DESTINO_PRUEBAS = 'qa@hatunsales.pe';
    comprobantes.obtenerDetalle.mockResolvedValue(detalle({ ambiente_fiscal: 'beta' }));
    expect(await servicio.procesar(5)).toBe('ENVIADO');
    const mensaje = (enviador.enviar.mock.calls as any[][])[0][0];
    expect(mensaje.para).toBe('qa@hatunsales.pe');
    expect(mensaje.asunto.startsWith('PRUEBA SUNAT BETA – SIN VALIDEZ')).toBe(true);
    expect(repo.marcarEnviado).toHaveBeenCalledWith(5, 'msg-1', 'qa@hatunsales.pe');
  });

  it('BETA sin correo de pruebas se omite y no envía nada', async () => {
    const { servicio, comprobantes, repo, enviador } = montar();
    delete process.env.CORREO_DESTINO_PRUEBAS;
    comprobantes.obtenerDetalle.mockResolvedValue(detalle({ ambiente_fiscal: 'beta' }));
    expect(await servicio.procesar(5)).toBe('OMITIDO');
    expect(repo.marcarOmitido).toHaveBeenCalledWith(5, 'ambiente beta sin correo de pruebas');
    expect(enviador.enviar).not.toHaveBeenCalled();
  });

  it('se omite si no hay comprobante electrónico, si está rechazado/anulado o si el correo no es válido', async () => {
    const { servicio, comprobantes, repo } = montar();
    comprobantes.obtenerDetalle.mockResolvedValueOnce(detalle({ proveedor_fiscal: null }));
    expect(await servicio.procesar(5)).toBe('OMITIDO');
    expect(repo.marcarOmitido).toHaveBeenLastCalledWith(5, 'sin comprobante electrónico');
    comprobantes.obtenerDetalle.mockResolvedValueOnce(detalle({ estado_sunat: 'RECHAZADO' }));
    expect(await servicio.procesar(5)).toBe('OMITIDO');
    expect(repo.marcarOmitido).toHaveBeenLastCalledWith(5, 'comprobante rechazado o anulado');
    repo.reclamar.mockResolvedValueOnce(fila({ destino: 'no-es-correo' }) as any);
    expect(await servicio.procesar(5)).toBe('OMITIDO');
    expect(repo.marcarOmitido).toHaveBeenLastCalledWith(5, 'correo del cliente no válido');
  });

  it('un fallo reintentable vuelve a PENDIENTE con espera creciente; agotado el tope queda en ERROR', async () => {
    const { servicio, repo, enviador } = montar();
    enviador.enviar.mockRejectedValue(new ErrorEnvioCorreo('503', true, 503));
    expect(await servicio.procesar(5)).toBe('PENDIENTE');
    expect(repo.marcarError).toHaveBeenLastCalledWith(5, '503', 1);
    repo.reclamar.mockResolvedValueOnce(fila({ intentos: 3 }) as any);
    await servicio.procesar(5);
    expect(repo.marcarError).toHaveBeenLastCalledWith(5, '503', 15);
    repo.reclamar.mockResolvedValueOnce(fila({ intentos: 5 }) as any);
    expect(await servicio.procesar(5)).toBe('ERROR');
    expect(repo.marcarError).toHaveBeenLastCalledWith(5, '503', null);
  });

  it('un rechazo definitivo del proveedor deja ERROR sin reintentos', async () => {
    const { servicio, repo, enviador } = montar();
    enviador.enviar.mockRejectedValue(new ErrorEnvioCorreo('destinatario inválido', false, 400));
    expect(await servicio.procesar(5)).toBe('ERROR');
    expect(repo.marcarError).toHaveBeenCalledWith(5, 'destinatario inválido', null);
  });

  describe('reenviar', () => {
    it('crea la fila manual con el destino indicado, la procesa en el acto y devuelve la fila', async () => {
      const { servicio, repo, enviador } = montar();
      repo.reclamar.mockResolvedValueOnce(fila({ id_correo: 31, destino: 'otro@ejemplo.pe', origen: 'manual' }) as any);
      const resultado = await servicio.reenviar(20, ' otro@ejemplo.pe ', 7);
      expect(repo.crearManual).toHaveBeenCalledWith(20, 'otro@ejemplo.pe', 7);
      expect(enviador.enviar).toHaveBeenCalledTimes(1);
      expect(resultado.estado).toBe('ENVIADO');
    });

    it('sin destino usa el correo del receptor', async () => {
      const { servicio, repo } = montar();
      await servicio.reenviar(20, undefined, null);
      expect(repo.crearManual).toHaveBeenCalledWith(20, 'ana@ejemplo.pe', null);
    });

    it('rechaza: correo inválido o ausente, comprobante no aceptado, interruptor apagado, sin tabla', async () => {
      const m = montar();
      await expect(m.servicio.reenviar(20, 'malo', 1)).rejects.toBeInstanceOf(BadRequestException);
      m.comprobantes.obtenerDetalle.mockResolvedValue(detalle({ receptor: { email: '' } }));
      await expect(m.servicio.reenviar(20, undefined, 1)).rejects.toBeInstanceOf(BadRequestException);
      m.comprobantes.obtenerDetalle.mockResolvedValue(detalle({ estado_sunat: 'PENDIENTE' }));
      await expect(m.servicio.reenviar(20, 'a@b.pe', 1)).rejects.toBeInstanceOf(BadRequestException);
      m.comprobantes.obtenerDetalle.mockResolvedValue(detalle({ proveedor_fiscal: null }));
      await expect(m.servicio.reenviar(20, 'a@b.pe', 1)).rejects.toBeInstanceOf(BadRequestException);
      m.config.leer.mockResolvedValueOnce({ correo_envio_activo: null } as any);
      await expect(m.servicio.reenviar(20, 'a@b.pe', 1)).rejects.toBeInstanceOf(ConflictException);
      m.repo.tablaDisponible.mockResolvedValueOnce(false);
      await expect(m.servicio.reenviar(20, 'a@b.pe', 1)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(m.repo.crearManual).not.toHaveBeenCalled();
    });

    it('el cuarto reenvío en una hora responde 429 y un envío abierto responde 409', async () => {
      const m = montar();
      m.repo.reenviosUltimaHora.mockResolvedValueOnce(3);
      const error = await m.servicio.reenviar(20, 'a@b.pe', 1).catch((e) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(429);
      expect(m.repo.crearManual).not.toHaveBeenCalled();
      m.repo.crearManual.mockResolvedValueOnce(null as any);
      await expect(m.servicio.reenviar(20, 'a@b.pe', 1)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('estadoResumen', () => {
    it('sin filas deriva el estado de enviar_cliente', async () => {
      const { servicio } = montar();
      expect((await servicio.estadoResumen(detalle({ enviar_cliente: false }) as any)).estado).toBe('SIN_SOLICITAR');
      const pendiente = await servicio.estadoResumen(detalle() as any);
      expect(pendiente).toMatchObject({ estado: 'PENDIENTE', destino: 'ana@ejemplo.pe', puede_reenviar: true });
      const omitido = await servicio.estadoResumen(detalle({ proveedor_fiscal: null }) as any);
      expect(omitido).toMatchObject({ estado: 'OMITIDO', puede_reenviar: false });
    });

    it('con filas usa la última y puede_reenviar solo para aceptados sunat_directo no anulados', async () => {
      const { servicio, repo } = montar();
      repo.ultimo.mockResolvedValue(fila({ estado: 'ERROR', ultimo_error: 'timeout' }));
      const resumen = await servicio.estadoResumen(detalle({ estado_sunat: 'PENDIENTE' }) as any);
      expect(resumen).toMatchObject({ estado: 'ERROR', ultimo_error: 'timeout', puede_reenviar: false });
    });

    it('si la tabla no existe o falla la lectura, no rompe el detalle', async () => {
      const { servicio, repo } = montar();
      repo.tablaDisponible.mockResolvedValueOnce(false);
      expect((await servicio.estadoResumen(detalle() as any)).estado).toBe('PENDIENTE');
      repo.tablaDisponible.mockRejectedValueOnce(new Error('bd caída'));
      expect((await servicio.estadoResumen(detalle() as any)).estado).toBe('PENDIENTE');
    });
  });
});
