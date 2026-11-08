import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { emisorConfig } from '../../config/emisor.config';
import { ResumenDiarioBussnies } from '../Bussnies/resumen-diario.bussnies';
import { ResumenDiarioTarea } from './resumen-diario.tarea';

/**
 * El resumen diario se prueba con dobles: configuración en memoria, reportes y repositorios falsos y un enviador que
 * anota los correos. Nada toca la base de datos ni la red.
 */
const dia = (fecha: string, total = 100) => ({ fecha, total, ventas: 2, ticket_promedio: total / 2 });

function montar(valores: Record<string, string> = {}, opciones: { falla?: boolean; envio?: jest.Mock } = {}) {
  const guardados: Record<string, string> = { ...valores };
  const config = {
    obtener: jest.fn(async (clave: string) => (guardados[clave] ? guardados[clave] : null)),
    obtenerVarias: jest.fn(async (claves: string[]) => Object.fromEntries(claves.map((c) => [c, guardados[c] ? guardados[c] : null]))),
    guardar: jest.fn(async (clave: string, valor: string) => {
      guardados[clave] = valor;
    }),
  };
  const reportes = { resumenDia: jest.fn(async (f: string) => dia(f)) };
  const reportesRepo = {
    obtenerComprobantesConProblema: jest.fn().mockResolvedValue([{ id_comprobante: 9, serie: 'B001', numero: 7, estado: 'error', estado_sunat: null }]),
    contarPedidosWeb: jest.fn().mockResolvedValue({ pendientes: 1, pagados: 2 }),
  };
  const caja = {
    resumenSucursales: jest.fn().mockResolvedValue({
      total: { turnos_abiertos: 0, por_metodo: [{ metodo: 'Efectivo', monto: 80 }, { metodo: 'Crédito', monto: 500 }, { metodo: 'Yape', monto: 0 }] },
    }),
  };
  const comprobantes = { monitorAtencion: jest.fn().mockResolvedValue({ pendientes: 1, errores: 1, total: 2 }) };
  const credito = { deudaVencida: jest.fn().mockResolvedValue({ cuentas: 1, total: 300, mayores: [{ deudor: 'A', saldo: 300, dias: 5, comprobante: null }] }) };
  const inventario = {
    resumen: jest.fn().mockResolvedValue({ sin_stock: 2, bajo_stock: 1 }),
    listarDetallado: jest.fn().mockResolvedValue({
      datos: [
        { producto: 'Sin mínimo', almacen: 'P', stock: 0, stock_minimo: 0, estado: 'sin_stock' },
        { producto: 'Bajo', almacen: 'P', stock: 2, stock_minimo: 5, estado: 'bajo' },
        { producto: 'Agotado', almacen: 'P', stock: 0, stock_minimo: 10, estado: 'sin_stock' },
        { producto: 'Bien', almacen: 'P', stock: 50, stock_minimo: 5, estado: 'ok' },
      ],
    }),
  };
  const envio = opciones.envio ?? jest.fn(async () => {
    if (opciones.falla) throw new Error('Brevo 503');
    return { id_mensaje: 'x' };
  });
  const enviador = { nombre: 'archivo', enviar: envio };
  const bussnies = new ResumenDiarioBussnies(
    config as any, reportes as any, reportesRepo as any, caja as any, comprobantes as any, credito as any, inventario as any, enviador as any,
  );
  const fiscal = { tareasActivas: jest.fn().mockResolvedValue(true) };
  const tarea = new ResumenDiarioTarea(fiscal as any, bussnies);
  return { bussnies, tarea, config, guardados, envio, fiscal, reportes, inventario, caja };
}

const ENCENDIDO = { resumen_diario_activo: 'true', resumen_diario_correos: 'dueno@hatunsales.pe' };
// 5/11/2026: 20:29 y 20:30 en Lima (UTC-5).
const A_LAS_2029 = new Date('2026-11-06T01:29:00Z');
const A_LAS_2030 = new Date('2026-11-06T01:30:00Z');

describe('ResumenDiarioTarea · cuándo envía', () => {
  it('no envía con el interruptor apagado (por defecto) ni antes de la hora de Lima', async () => {
    const apagado = montar({ resumen_diario_correos: 'dueno@hatunsales.pe' });
    expect(await apagado.tarea.ejecutar(A_LAS_2030)).toBe('inactivo');

    const temprano = montar(ENCENDIDO);
    expect(await temprano.tarea.ejecutar(A_LAS_2029)).toBe('antes_de_hora');
    expect(temprano.envio).not.toHaveBeenCalled();
  });

  it('a las 20:30 de Lima (hora por defecto) envía, y solo una vez al día', async () => {
    const t = montar(ENCENDIDO);

    expect(await t.tarea.ejecutar(A_LAS_2030)).toBe('enviado');
    expect(t.envio).toHaveBeenCalledTimes(1);
    expect(t.guardados.resumen_diario_ultimo_envio).toBe('2026-11-05');

    expect(await t.tarea.ejecutar(new Date('2026-11-06T02:00:00Z'))).toBe('ya_enviado');
    expect(t.envio).toHaveBeenCalledTimes(1);

    // Al día siguiente, a la hora, vuelve a enviar.
    expect(await t.tarea.ejecutar(new Date('2026-11-07T01:31:00Z'))).toBe('enviado');
    expect(t.guardados.resumen_diario_ultimo_envio).toBe('2026-11-06');
  });

  it('respeta la hora configurada y usa la hora de Lima, no la del servidor', async () => {
    const t = montar({ ...ENCENDIDO, resumen_diario_hora: '18:00' });

    // 17:59 en Lima = 22:59 UTC: todavía no.
    expect(await t.tarea.ejecutar(new Date('2026-11-05T22:59:00Z'))).toBe('antes_de_hora');
    expect(await t.tarea.ejecutar(new Date('2026-11-05T23:00:00Z'))).toBe('enviado');
  });

  it('sin correos escritos usa el correo del emisor y sin ninguno no envía', async () => {
    const conEmisor = montar({ resumen_diario_activo: 'true', emisor_email: 'ventas@hatunsales.pe' });
    expect(await conEmisor.tarea.ejecutar(A_LAS_2030)).toBe('enviado');
    expect(conEmisor.envio.mock.calls[0][0].para).toBe('ventas@hatunsales.pe');
    expect((await conEmisor.bussnies.obtenerConfiguracion()).correos).toEqual([]);

    const sinNada = montar({ resumen_diario_activo: 'true' });
    const original = emisorConfig.email;
    (emisorConfig as any).email = '';
    try {
      expect(await sinNada.tarea.ejecutar(A_LAS_2030)).toBe('sin_destinatarios');
    } finally {
      (emisorConfig as any).email = original;
    }
    expect(sinNada.envio).not.toHaveBeenCalled();
  });

  it('si el envío falla no marca el día, reintenta en la vuelta siguiente y se rinde tras tres fallos', async () => {
    const t = montar(ENCENDIDO, { falla: true });

    expect(await t.tarea.ejecutar(A_LAS_2030)).toBe('fallo');
    expect(t.guardados.resumen_diario_ultimo_envio).toBeUndefined();
    expect(t.guardados.resumen_diario_fallos).toBe('2026-11-05:1');

    expect(await t.tarea.ejecutar(new Date('2026-11-06T01:35:00Z'))).toBe('fallo');
    expect(await t.tarea.ejecutar(new Date('2026-11-06T01:40:00Z'))).toBe('fallo');
    expect(t.guardados.resumen_diario_fallos).toBe('2026-11-05:3');

    expect(await t.tarea.ejecutar(new Date('2026-11-06T01:45:00Z'))).toBe('agotado');
    expect(t.envio).toHaveBeenCalledTimes(3);

    // Al día siguiente el contador empieza de nuevo.
    t.envio.mockResolvedValue({ id_mensaje: 'ok' });
    expect(await t.tarea.ejecutar(new Date('2026-11-07T01:31:00Z'))).toBe('enviado');
  });

  it('un fallo seguido de un envío correcto marca el día y limpia el contador', async () => {
    const envio = jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ id_mensaje: 'ok' });
    const t = montar(ENCENDIDO, { envio });

    expect(await t.tarea.ejecutar(A_LAS_2030)).toBe('fallo');
    expect(await t.tarea.ejecutar(new Date('2026-11-06T01:35:00Z'))).toBe('enviado');
    expect(t.guardados.resumen_diario_ultimo_envio).toBe('2026-11-05');
    expect(t.guardados.resumen_diario_fallos).toBe('');
  });

  it('no corre con las tareas apagadas y nunca lanza', async () => {
    const t = montar(ENCENDIDO);
    t.fiscal.tareasActivas.mockResolvedValueOnce(false);
    expect(await t.tarea.ejecutar(A_LAS_2030)).toBe('tareas_apagadas');

    t.config.obtenerVarias.mockRejectedValueOnce(new Error('BD caída'));
    expect(await t.tarea.ejecutar(A_LAS_2030)).toBe('error');
    expect(t.envio).not.toHaveBeenCalled();
  });
});

describe('ResumenDiarioBussnies · enviar ahora y configuración', () => {
  it('«enviar ahora» manda el resumen de hoy a todos los destinatarios y NO marca el día', async () => {
    const t = montar({ resumen_diario_correos: 'a@x.pe, b@x.pe' });

    const r = await t.bussnies.enviarAhora(A_LAS_2029);

    expect(r.enviados).toEqual(['a@x.pe', 'b@x.pe']);
    expect(r.fallidos).toEqual([]);
    expect(r.proveedor).toBe('archivo');
    expect(r.asunto.startsWith('PRUEBA – Resumen del 05/11/2026')).toBe(true);
    expect(t.envio).toHaveBeenCalledTimes(2);
    expect(t.envio.mock.calls[0][0]).toMatchObject({ adjuntos: [] });
    expect(t.guardados.resumen_diario_ultimo_envio).toBeUndefined();
  });

  it('«enviar ahora» sin destinatarios da 400 y, si todos fallan, 503 con el motivo', async () => {
    const original = emisorConfig.email;
    (emisorConfig as any).email = '';
    try {
      await expect(montar({}).bussnies.enviarAhora()).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      (emisorConfig as any).email = original;
    }
    const caido = montar({ resumen_diario_correos: 'a@x.pe' }, { falla: true });
    await expect(caido.bussnies.enviarAhora()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(caido.bussnies.enviarAhora()).rejects.toThrow('Brevo 503');
  });

  it('arma el resumen con lo que ya existe: caja sin crédito, stock crítico ordenado y una sección caída no tumba el correo', async () => {
    const t = montar(ENCENDIDO);
    t.reportes.resumenDia.mockImplementation(async (f: string) => {
      if (f === '2026-11-04') throw new Error('falló ayer');
      return dia(f);
    });

    const datos = await t.bussnies.recopilar('2026-11-05', false);

    expect(datos.ventas).toBeNull();
    expect(datos.caja).toEqual({ total: 80, turnos_abiertos: 0, por_metodo: [{ metodo: 'Efectivo', monto: 80 }] });
    expect(datos.stock!.criticos.map((p) => p.producto)).toEqual(['Agotado', 'Bajo', 'Sin mínimo']);
    expect(datos.stock).toMatchObject({ sin_stock: 2, bajo_stock: 1 });
    expect(datos.comprobantes).toEqual({ pendientes: 1, errores: 1, recientes: [{ numero: 'B001-00000007', estado: 'con error' }] });
    expect(datos.pedidos).toEqual({ pendientes: 1, pagados: 2 });
    expect(t.caja.resumenSucursales.mock.calls[0][1]).toEqual({ desde: '2026-11-05', hasta: '2026-11-05' });
  });

  it('guarda la configuración validada y rechaza horas y correos mal escritos', async () => {
    const t = montar({});

    const c = await t.bussnies.guardarConfiguracion({ activo: true, hora: '21:15', correos: ['Dueno@x.pe', 'dueno@x.pe', 'otro@x.pe'] });

    expect(t.guardados).toMatchObject({ resumen_diario_activo: 'true', resumen_diario_hora: '21:15', resumen_diario_correos: 'Dueno@x.pe,otro@x.pe' });
    expect(c).toMatchObject({ activo: true, hora: '21:15', correos: ['Dueno@x.pe', 'otro@x.pe'], ultimo_envio: null });
    await expect(t.bussnies.guardarConfiguracion({ hora: '25:00' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.bussnies.guardarConfiguracion({ hora: '8:30' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.bussnies.guardarConfiguracion({ correos: 'bueno@x.pe, malo' })).rejects.toThrow('malo');
    await expect(t.bussnies.guardarConfiguracion({ activo: 'si' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
