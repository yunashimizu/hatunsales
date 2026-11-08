import { BadRequestException, Logger } from '@nestjs/common';
import { RelojFiscal } from '../config/reloj-fiscal';
import { AlertasFiscalesService, COLA_ATASCADA_MINIMO } from './alertas-fiscales.service';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-11-09T13:05:00Z'); // 08:05 en Lima
  }
}

function crear(opciones: {
  proveedor?: string;
  ambiente?: 'beta' | 'produccion';
  cert?: { dias_para_vencer: number; vencido?: boolean; ambiente?: string } | null;
  contadores?: Partial<{ excepcion: number; lotes_por_liberar: number; pendientes_antiguos: number }>;
  vencenHoy?: number;
  yaEnviadas?: string[];
  correo?: string | null;
  emisor?: string | null;
  fallaCorreo?: boolean;
} = {}) {
  const ambiente = opciones.ambiente ?? 'produccion';
  const config = {
    snapshot: jest.fn(async () => ({ ambiente })),
    proveedorActivo: jest.fn(async () => opciones.proveedor ?? 'sunat_directo'),
  };
  const cert = opciones.cert === undefined ? { dias_para_vencer: 200, vencido: false, ambiente } : opciones.cert;
  const certificados = {
    infoTodos: jest.fn(async () => ({ beta: null, produccion: cert ? { ambiente: 'produccion', vencido: false, ...cert } : null })),
  };
  const envios = { contadores: jest.fn(async () => ({ pendientes: 0, inciertos: 0, vencen_hoy: opciones.vencenHoy ?? 0, vencidos: 0 })) };
  const repositorio = {
    contadores: jest.fn(async () => ({ excepcion: 0, lotes_por_liberar: 0, pendientes_antiguos: 0, ...opciones.contadores })),
  };
  const auditoria = {
    existeHoy: jest.fn(async (_a: string, _c: string, tipo: string) => (opciones.yaEnviadas ?? []).includes(tipo)),
    registrar: jest.fn(async () => undefined),
  };
  const enviador = {
    nombre: 'prueba',
    enviar: jest.fn(async () => {
      if (opciones.fallaCorreo) throw new Error('proveedor caído');
      return { id_mensaje: 'm1' };
    }),
  };
  const guardados: Record<string, string> = {};
  const configuracion = {
    obtener: jest.fn(async (clave: string) =>
      clave === 'fiscal_alertas_correo' ? (opciones.correo ?? null) : clave === 'emisor_email' ? (opciones.emisor ?? null) : null,
    ),
    guardar: jest.fn(async (clave: string, valor: string) => { guardados[clave] = valor; }),
  };
  const servicio = new AlertasFiscalesService(
    config as any, certificados as any, envios as any, repositorio as any, auditoria as any, enviador as any, configuracion as any, new RelojPrueba(),
  );
  return { servicio, config, repositorio, auditoria, enviador, configuracion, guardados };
}

describe('AlertasFiscalesService (S7)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    delete process.env.EMISOR_EMAIL;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [200, null],
    [31, null],
    [30, 'certificado_30'],
    [16, 'certificado_30'],
    [15, 'certificado_15'],
    [8, 'certificado_15'],
    [7, 'certificado_7'],
    [2, 'certificado_7'],
    [1, 'certificado_1'],
    [0, 'certificado_1'],
  ])('certificado que vence en %s día(s) → alerta %s', async (dias, tipo) => {
    const { servicio } = crear({ cert: { dias_para_vencer: dias } });
    const tipos = (await servicio.detectar()).map((a) => a.tipo);
    expect(tipos).toEqual(tipo ? [tipo] : []);
  });

  it('un certificado vencido tiene su propio aviso', async () => {
    const { servicio } = crear({ cert: { dias_para_vencer: -3, vencido: true } });
    expect((await servicio.detectar()).map((a) => a.tipo)).toEqual(['certificado_vencido']);
  });

  it('detecta envíos que requieren revisión, lotes por liberar, plazos de hoy y cola atascada (solo por encima de 20)', async () => {
    const { servicio } = crear({
      contadores: { excepcion: 2, lotes_por_liberar: 1, pendientes_antiguos: COLA_ATASCADA_MINIMO + 1 },
      vencenHoy: 3,
    });
    expect((await servicio.detectar()).map((a) => a.tipo)).toEqual(['envios_revision', 'lotes_liberar', 'plazo_vence_hoy', 'cola_atascada']);

    const justo = crear({ contadores: { pendientes_antiguos: COLA_ATASCADA_MINIMO } });
    expect(await justo.servicio.detectar()).toEqual([]);
  });

  it('con otro proveedor fiscal no vigila nada', async () => {
    const { servicio, repositorio } = crear({ proveedor: 'nubefact', contadores: { excepcion: 5 } });
    await expect(servicio.detectar()).resolves.toEqual([]);
    expect(repositorio.contadores).not.toHaveBeenCalled();
  });

  it('manda UN correo con todas las situaciones nuevas al correo configurado y deja una auditoría por tipo', async () => {
    const { servicio, enviador, auditoria } = crear({ contadores: { excepcion: 2 }, vencenHoy: 1, correo: 'Contador@Empresa.pe' });

    const r = await servicio.enviarDelDia();

    expect(enviador.enviar).toHaveBeenCalledTimes(1);
    const mensaje = (enviador.enviar.mock.calls[0] as any[])[0];
    expect(mensaje.para).toBe('Contador@Empresa.pe');
    expect(mensaje.asunto).toContain('2 avisos');
    expect(mensaje.texto).toContain('requieren revisión');
    expect(r.enviadas).toEqual(['envios_revision', 'plazo_vence_hoy']);
    expect(auditoria.registrar).toHaveBeenCalledTimes(2);
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'FISCAL_ALERTA_ENVIADA', entidad: 'alerta', id_entidad: 'envios_revision',
    }));
  });

  it('no repite el mismo tipo el mismo día; si todo ya se avisó no manda nada', async () => {
    const parcial = crear({ contadores: { excepcion: 2 }, vencenHoy: 1, emisor: 'e@empresa.pe', yaEnviadas: ['envios_revision'] });
    const r = await parcial.servicio.enviarDelDia();
    expect(r.enviadas).toEqual(['plazo_vence_hoy']);
    expect(r.repetidas).toEqual(['envios_revision']);

    const todo = crear({ contadores: { excepcion: 2 }, emisor: 'e@empresa.pe', yaEnviadas: ['envios_revision'] });
    await todo.servicio.enviarDelDia();
    expect(todo.enviador.enviar).not.toHaveBeenCalled();
    expect(todo.auditoria.existeHoy).toHaveBeenCalledWith('FISCAL_ALERTA_ENVIADA', 'tipo', 'envios_revision', '2026-11-09');
  });

  it('sin correo configurado usa el del emisor; sin ninguno no envía y lo explica', async () => {
    const conEmisor = crear({ contadores: { excepcion: 1 }, emisor: 'ventas@hatunsales.pe' });
    await conEmisor.servicio.enviarDelDia();
    expect((conEmisor.enviador.enviar.mock.calls[0] as any[])[0].para).toBe('ventas@hatunsales.pe');

    const sin = crear({ contadores: { excepcion: 1 } });
    const r = await sin.servicio.enviarDelDia();
    expect(r.motivo).toMatch(/correo para los avisos/);
    expect(sin.enviador.enviar).not.toHaveBeenCalled();
    expect(sin.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si el correo falla propaga el error y NO registra el aviso (se reintentará)', async () => {
    const { servicio, auditoria } = crear({ contadores: { excepcion: 1 }, emisor: 'e@empresa.pe', fallaCorreo: true });
    await expect(servicio.enviarDelDia()).rejects.toThrow('proveedor caído');
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('guarda el correo en minúsculas, acepta vaciarlo y rechaza uno mal escrito', async () => {
    const { servicio, guardados, configuracion } = crear();
    await servicio.guardarCorreo('  Contador@Empresa.PE ');
    expect(guardados.fiscal_alertas_correo).toBe('contador@empresa.pe');

    await servicio.guardarCorreo('');
    expect(guardados.fiscal_alertas_correo).toBe('');

    configuracion.guardar.mockClear();
    await expect(servicio.guardarCorreo('no-es-correo')).rejects.toBeInstanceOf(BadRequestException);
    expect(configuracion.guardar).not.toHaveBeenCalled();
  });

  it('el estado distingue el correo configurado del del emisor', async () => {
    expect(await crear({ correo: 'a@b.pe', emisor: 'e@e.pe' }).servicio.estado()).toEqual({ correo: 'a@b.pe', correo_efectivo: 'a@b.pe', origen: 'configurado' });
    expect(await crear({ emisor: 'e@e.pe' }).servicio.estado()).toEqual({ correo: null, correo_efectivo: 'e@e.pe', origen: 'emisor' });
    expect(await crear().servicio.estado()).toEqual({ correo: null, correo_efectivo: null, origen: 'ninguno' });
  });
});
