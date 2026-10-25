import { Logger } from '@nestjs/common';
import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { snapshotPrueba, VALORES_COMPLETOS } from '../config/configuracion.prueba-spec';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import type { SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import type { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { EMISOR_PRUEBA, facturaPrueba } from '../nucleo/pruebas/documentos-prueba-spec';
import type { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { EmisionDirectaService } from './emision-directa.service';
import type { DocumentoPreparado } from './emision.contrato';
import { AVISO_BETA, SERIES_BETA } from './emision.tipos';
import type { EmisorBetaService } from './emisor-beta.service';
import type { EnvioFiscalRepository } from './envio-fiscal.repository';
import type { SunatEmisionService } from './sunat-emision.service';

const EMISOR_BETA = { ...EMISOR_PRUEBA, ruc: '20614736420', razonSocial: 'EMISOR DE PRUEBAS BETA' };
const ESQUEMA_LISTO = { verificado: true, listo: true, grupos: { secretos: true, auditoria: true, emision: true, catalogo: true }, faltantes: [], mensaje: null };
const BLOQUEO = JSON.stringify({ codigo: '0102', motivo: 'SUNAT rechazó el usuario o la clave SOL.', fecha: '2026-10-20T10:00:00.000Z' });

const EN_BETA = { ...VALORES_COMPLETOS, fiscal_ambiente: 'beta', fiscal_beta_pos_directo: 'true' };
const EN_PRODUCCION = { ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo' };

function crear(valores: Record<string, string> = EN_PRODUCCION, opciones: { material?: Record<string, unknown>; usuarioSol?: string } = {}) {
  let snapshot: SnapshotConfigFiscal = snapshotPrueba(valores);
  const config = {
    snapshotFresco: jest.fn(async () => snapshot),
    invalidar: jest.fn(),
  };
  const configGuardada: Record<string, string> = { fiscal_ambiente: snapshot.ambiente };
  const configuraciones = {
    leer: jest.fn(async (claves: readonly string[]) => Object.fromEntries(claves.map((c) => [c, configGuardada[c] ?? null]))),
    guardar: jest.fn(async () => undefined),
  };
  const esquema = {
    estado: jest.fn(async () => ESQUEMA_LISTO),
    exigir: jest.fn(async () => undefined),
    tiene: jest.fn(async () => true),
  };
  const emisorBeta = { obtenerEmisor: jest.fn(async () => ({ ...EMISOR_BETA })) };
  const material = { privateKeyPem: 'k', certificatePem: 'c', huellaSha256: 'h', ruc: '20610206337', vigenteHasta: new Date('2028-01-01'), autofirmado: false, ...opciones.material };
  const certificados = {
    obtenerMaterialFirma: jest.fn(async () => ({ ...material })),
    obtenerMaterialFirmaBeta: jest.fn(async () => ({ ...material, ruc: opciones.material?.ruc === undefined ? EMISOR_BETA.ruc : material.ruc })),
    infoActivo: jest.fn(async () => ({ ruc: EMISOR_BETA.ruc, vencido: false })),
  };
  const credencialesSol = { obtener: jest.fn(async () => ({ usuario: opciones.usuarioSol ?? '20610206337HATUN001', clave: 'secreta' })) };
  const preparado = { nombreBase: 'X', zip: {}, digestValue: 'D', cadenaQr: 'Q' };
  const emision = {
    preparar: jest.fn(() => preparado),
    registrar: jest.fn(async () => 321),
    enviar: jest.fn(async () => ({ id_envio: 321, aceptado: true })),
    reintentar: jest.fn(async () => ({})),
    recuperarCdr: jest.fn(async () => ({})),
    confirmarAceptadoManual: jest.fn(async () => ({})),
    probarCredencialesProduccion: jest.fn(async () => ({ ok: true })),
  };
  const envios = {
    primerosLibresBeta: jest.fn(async () => ({ FB01: 4, BB01: 5 })),
    listar: jest.fn(async () => ({ datos: [], total: 0, pagina: 1, por_pagina: 20 })),
    obtener: jest.fn(async () => null),
    archivo: jest.fn(async () => null),
  };
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const tx = { query: jest.fn(async () => []) };
  const transacciones = { ejecutar: jest.fn(async (trabajo: (e: typeof tx) => Promise<unknown>) => trabajo(tx)) };
  const servicio = new EmisionDirectaService(
    config as unknown as FiscalConfigService,
    configuraciones as unknown as RepositorioConfigFiscal,
    esquema as unknown as FiscalEsquemaService,
    emisorBeta as unknown as EmisorBetaService,
    certificados as unknown as CertificadoFiscalService,
    credencialesSol as unknown as CredencialesSolService,
    emision as unknown as SunatEmisionService,
    envios as unknown as EnvioFiscalRepository,
    auditoria as unknown as FiscalAuditoriaRepository,
    transacciones as unknown as TransaccionesFiscales,
  );
  return {
    servicio,
    config,
    configuraciones,
    configGuardada,
    esquema,
    certificados,
    credencialesSol,
    emision,
    envios,
    auditoria,
    transacciones,
    tx,
    cambiar: (nuevos: Record<string, string>) => (snapshot = snapshotPrueba(nuevos)),
  };
}

async function codigoDe(promesa: Promise<unknown>): Promise<string | null> {
  try {
    await promesa;
    return null;
  } catch (error) {
    return error instanceof FiscalConfigError ? error.codigo : `otro: ${(error as Error).message}`;
  }
}

describe('EmisionDirectaService.modo() (nunca lanza)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('BETA activa solo con el interruptor del POS; PRODUCCIÓN activa solo con sunat_directo', async () => {
    expect(await crear(EN_BETA).servicio.modo()).toEqual({ activo: true, ambiente: 'beta' });
    expect(await crear({ ...EN_BETA, fiscal_beta_pos_directo: '' }).servicio.modo()).toMatchObject({
      activo: false,
      ambiente: 'beta',
      codigo: 'FISCAL_BETA_POS_APAGADO',
    });
    expect(await crear(EN_PRODUCCION).servicio.modo()).toEqual({ activo: true, ambiente: 'produccion' });
    expect(await crear(VALORES_COMPLETOS).servicio.modo()).toMatchObject({ activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA' });
    // El proveedor de producción no enciende BETA ni el interruptor de BETA enciende producción.
    expect(await crear({ ...VALORES_COMPLETOS, fiscal_beta_pos_directo: 'true' }).servicio.modo()).toMatchObject({ activo: false });
  });

  it('con el interruptor del ambiente abierto queda inactiva con su motivo (el del otro ambiente no influye)', async () => {
    const detenida = await crear({ ...EN_PRODUCCION, fiscal_emision_bloqueada_produccion: BLOQUEO }).servicio.modo();
    expect(detenida).toMatchObject({ activo: false, codigo: 'FISCAL_EMISION_BLOQUEADA' });
    expect((detenida as { motivo: string }).motivo).toMatch(/rechazó el usuario o la clave SOL/);
    expect(await crear({ ...EN_PRODUCCION, fiscal_emision_bloqueada_beta: BLOQUEO }).servicio.modo()).toEqual({ activo: true, ambiente: 'produccion' });
  });

  it('sin el esquema fiscal: FISCAL_MIGRACION_PENDIENTE; si no se pudo verificar o leer: FISCAL_LECTURA_ERROR', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sinEsquema = crear(EN_PRODUCCION);
    sinEsquema.esquema.estado.mockResolvedValueOnce({ ...ESQUEMA_LISTO, listo: false, grupos: { ...ESQUEMA_LISTO.grupos, emision: false } });
    expect(await sinEsquema.servicio.modo()).toMatchObject({ activo: false, codigo: 'FISCAL_MIGRACION_PENDIENTE' });

    const sinVerificar = crear(EN_PRODUCCION);
    sinVerificar.esquema.estado.mockResolvedValueOnce({ ...ESQUEMA_LISTO, verificado: false, listo: false });
    expect(await sinVerificar.servicio.modo()).toMatchObject({ activo: false, codigo: 'FISCAL_LECTURA_ERROR' });

    const caida = crear(EN_PRODUCCION);
    caida.config.snapshotFresco.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(caida.servicio.modo()).resolves.toMatchObject({ activo: false, codigo: 'FISCAL_LECTURA_ERROR' });
  });

  it('lee la configuración sin caché en cada llamada (nada de caché para decidir emitir)', async () => {
    const { servicio, config } = crear(EN_PRODUCCION);
    await servicio.modo();
    await servicio.modo();
    expect(config.snapshotFresco).toHaveBeenCalledTimes(2);
  });
});

describe('EmisionDirectaService.contexto()', () => {
  it('BETA: emisor de pruebas, series FB01/BB01/…, aviso y primer número libre según los envíos BETA', async () => {
    const { servicio, envios } = crear(EN_BETA);
    const contexto = await servicio.contexto();
    expect(contexto).toEqual({
      ambiente: 'beta',
      emisor: expect.objectContaining({ ruc: '20614736420', razonSocial: 'EMISOR DE PRUEBAS BETA' }),
      series: { ...SERIES_BETA },
      aviso: AVISO_BETA,
      correlativo_inicial: { FB01: 4, BB01: 5 },
    });
    expect(envios.primerosLibresBeta).toHaveBeenCalledWith(Object.values(SERIES_BETA));
  });

  it('PRODUCCIÓN: emisor real, series configuradas, sin aviso y correlativo inicial solo de esas series', async () => {
    const { servicio, envios } = crear({ ...EN_PRODUCCION, fiscal_cpe_correlativo_inicial: '{"F001":120,"BC01":3,"FFF1":9}' });
    const contexto = await servicio.contexto();
    expect(contexto).toEqual({
      ambiente: 'produccion',
      emisor: expect.objectContaining({ ruc: '20610206337', razonSocial: 'HATUNSALES S.A.C.' }),
      series: { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', nc_boleta: 'BC01', nd_factura: 'FD01', nd_boleta: 'BD01' },
      aviso: null,
      correlativo_inicial: { F001: 120, BC01: 3 },
    });
    expect(envios.primerosLibresBeta).not.toHaveBeenCalled();
  });

  it('con la emisión inactiva lanza el código del modo (el negocio registra la venta sin comprobante)', async () => {
    expect(await codigoDe(crear(VALORES_COMPLETOS).servicio.contexto())).toBe('FISCAL_EMISION_INACTIVA');
    expect(await codigoDe(crear({ ...EN_BETA, fiscal_emision_bloqueada_beta: BLOQUEO }).servicio.contexto())).toBe('FISCAL_EMISION_BLOQUEADA');
  });
});

describe('EmisionDirectaService.prepararDocumento() (guardas de D1 antes de cualquier efecto)', () => {
  const documento = () => facturaPrueba(undefined, { serie: 'F001', numero: 120 });

  it('PRODUCCIÓN: firma con el certificado de producción y el usuario SOL del emisor', async () => {
    const { servicio, certificados, credencialesSol, emision } = crear(EN_PRODUCCION);
    const preparado = await servicio.prepararDocumento(documento());
    expect(certificados.obtenerMaterialFirma).toHaveBeenCalledWith('produccion');
    expect(certificados.obtenerMaterialFirmaBeta).not.toHaveBeenCalled();
    expect(credencialesSol.obtener).toHaveBeenCalledWith('produccion');
    expect(emision.preparar).toHaveBeenCalledWith(expect.objectContaining({ serie: 'F001' }), expect.objectContaining({ ruc: '20610206337' }), 'auto');
    expect(preparado).toMatchObject({ ambiente: 'produccion', documento: { numero: 120 } });
  });

  it('BETA: usa el certificado BETA exclusivo y no pide credenciales SOL', async () => {
    const { servicio, certificados, credencialesSol } = crear(EN_BETA);
    const doc = facturaPrueba(undefined, { serie: 'FB01', numero: 4, emisor: { ...EMISOR_BETA } });
    await servicio.prepararDocumento(doc);
    expect(certificados.obtenerMaterialFirmaBeta).toHaveBeenCalled();
    expect(certificados.obtenerMaterialFirma).not.toHaveBeenCalled();
    expect(credencialesSol.obtener).not.toHaveBeenCalled();
  });

  it('certificado de otro RUC: FISCAL_CERT_RUC_NO_COINCIDE sin preparar nada', async () => {
    const { servicio, emision } = crear(EN_PRODUCCION, { material: { ruc: '20100070970' } });
    expect(await codigoDe(servicio.prepararDocumento(documento()))).toBe('FISCAL_CERT_RUC_NO_COINCIDE');
    expect(emision.preparar).not.toHaveBeenCalled();
  });

  it('certificado sin RUC legible: solo con la confirmación del administrador', async () => {
    const sinConfirmar = crear(EN_PRODUCCION, { material: { ruc: null } });
    expect(await codigoDe(sinConfirmar.servicio.prepararDocumento(documento()))).toBe('FISCAL_CERT_RUC_SIN_CONFIRMAR');
    expect(sinConfirmar.emision.preparar).not.toHaveBeenCalled();

    const confirmado = crear({ ...EN_PRODUCCION, fiscal_cert_ruc_confirmado_produccion: 'true' }, { material: { ruc: null } });
    await expect(confirmado.servicio.prepararDocumento(documento())).resolves.toMatchObject({ ambiente: 'produccion' });
  });

  it('usuario SOL de otro RUC: FISCAL_SOL_RUC_NO_COINCIDE', async () => {
    const { servicio, emision } = crear(EN_PRODUCCION, { usuarioSol: '20100070970HATUN001' });
    expect(await codigoDe(servicio.prepararDocumento(documento()))).toBe('FISCAL_SOL_RUC_NO_COINCIDE');
    expect(emision.preparar).not.toHaveBeenCalled();
  });

  it('un documento armado para otro ambiente (serie o emisor) no se prepara', async () => {
    const { servicio, emision } = crear(EN_PRODUCCION);
    expect(await codigoDe(servicio.prepararDocumento(facturaPrueba(undefined, { serie: 'FB01', numero: 4 })))).toBe('FISCAL_AMBIENTE_CAMBIO');
    expect(await codigoDe(servicio.prepararDocumento(facturaPrueba(undefined, { serie: 'F001', numero: 4, emisor: { ...EMISOR_BETA } })))).toBe(
      'FISCAL_AMBIENTE_CAMBIO',
    );
    expect(emision.preparar).not.toHaveBeenCalled();
  });

  it('con la emisión inactiva no prepara (ni pide certificado)', async () => {
    const { servicio, certificados } = crear(VALORES_COMPLETOS);
    expect(await codigoDe(servicio.prepararDocumento(documento()))).toBe('FISCAL_EMISION_INACTIVA');
    expect(certificados.obtenerMaterialFirma).not.toHaveBeenCalled();
  });
});

describe('EmisionDirectaService.registrarEnvio / emitirPreparado', () => {
  const preparado = (ambiente: 'beta' | 'produccion') =>
    ({ ambiente, documento: facturaPrueba(undefined, { serie: 'F001', numero: 120 }), material: {}, preparado: { nombreBase: 'X' } }) as unknown as DocumentoPreparado;

  it('lee el ambiente DENTRO de la transacción del negocio y, si cambió, falla con FISCAL_AMBIENTE_CAMBIO sin registrar', async () => {
    const { servicio, configuraciones, configGuardada, emision } = crear(EN_PRODUCCION);
    const consultor = { query: jest.fn() };
    configGuardada.fiscal_ambiente = 'beta';
    const error = await servicio.registrarEnvio(consultor, preparado('produccion'), 9, 1).catch((e) => e);
    expect(error).toMatchObject({ codigo: 'FISCAL_AMBIENTE_CAMBIO', detalle: { ambiente_preparado: 'produccion', ambiente_vigente: 'beta' } });
    expect(configuraciones.leer).toHaveBeenCalledWith(['fiscal_ambiente'], consultor);
    expect(emision.registrar).not.toHaveBeenCalled();
  });

  it('con el mismo ambiente delega en el motor con el consultor del negocio', async () => {
    const { servicio, emision } = crear(EN_PRODUCCION);
    const consultor = { query: jest.fn() };
    const p = preparado('produccion');
    expect(await servicio.registrarEnvio(consultor, p, 9, 1)).toBe(321);
    expect(emision.registrar).toHaveBeenCalledWith(consultor, 'produccion', p.documento, p.preparado, 9, 1);
  });

  it('emitirPreparado registra en su propia transacción y luego envía con el documento en memoria', async () => {
    const { servicio, transacciones, tx, emision } = crear(EN_PRODUCCION);
    const p = preparado('produccion');
    await servicio.emitirPreparado(p, 9, null);
    expect(transacciones.ejecutar).toHaveBeenCalledTimes(1);
    expect(emision.registrar).toHaveBeenCalledWith(tx, 'produccion', p.documento, p.preparado, 9, null);
    expect(emision.enviar).toHaveBeenCalledWith(321, { ambiente: 'produccion', documento: p.documento, preparado: p.preparado });
  });

  it('obtenerArchivo solo admite los tipos de la lista cerrada', async () => {
    const { servicio, envios } = crear(EN_PRODUCCION);
    expect(await codigoDe(servicio.obtenerArchivo(1, '../../etc/passwd' as never))).toBe('FISCAL_CONFIG_INVALIDA');
    await servicio.obtenerArchivo(1, 'cdr_xml');
    expect(envios.archivo).toHaveBeenCalledWith(1, 'cdr_xml');
  });
});

describe('EmisionDirectaService: interruptor de la emisión de prueba del POS (/fiscal/beta/pos)', () => {
  const ACTOR = { id_usuario: 7, nombre: 'admin', ip: '127.0.0.1' };

  it('activa y audita solo con ambiente BETA, esquema y certificado BETA del RUC del emisor de pruebas', async () => {
    const { servicio, configuraciones, auditoria, tx, config } = crear({ ...EN_BETA, fiscal_beta_pos_directo: '' });
    await servicio.cambiarEstado(true, ACTOR);
    expect(configuraciones.guardar).toHaveBeenCalledWith({ fiscal_beta_pos_directo: 'true' }, tx);
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ accion: 'POS_BETA_ACTIVADO', id_usuario: 7 }), tx);
    expect(config.invalidar).toHaveBeenCalled();
  });

  it('no activa con producción ni con un certificado BETA de otro RUC', async () => {
    expect(await codigoDe(crear(EN_PRODUCCION).servicio.cambiarEstado(true, ACTOR))).toBe('FISCAL_SOLO_BETA');
    const otroRuc = crear(EN_BETA, { material: { ruc: '20131312955' } });
    expect(await codigoDe(otroRuc.servicio.cambiarEstado(true, ACTOR))).toBe('FISCAL_CERT_RUC_NO_COINCIDE');
    expect(otroRuc.configuraciones.guardar).not.toHaveBeenCalled();
  });

  it('estado(): habilitado/activo/listo con los RUC del emisor y del certificado BETA', async () => {
    expect(await crear(EN_BETA).servicio.estado()).toMatchObject({
      habilitado: true,
      activo: true,
      ambiente: 'beta',
      listo: true,
      ruc_emisor_beta: '20614736420',
      ruc_certificado_beta: '20614736420',
    });
    expect(await crear({ ...EN_PRODUCCION, fiscal_beta_pos_directo: 'true' }).servicio.estado()).toMatchObject({ habilitado: true, activo: false });
  });
});
