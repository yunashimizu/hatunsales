import { evaluarPreparacion, HechosPreparacion } from './checklist-activacion';
import { certificadoPrueba, hechosPrueba, snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
import type { ActualizarConfigFiscalDto } from './fiscal-config.dto';
import { FiscalConfigError } from './fiscal-errores';
import { ConfirmacionNoOse, SnapshotConfigFiscal } from './fiscal-config.tipos';
import {
  cambiosDesdeDto,
  eventosAuditoria,
  paresParaGuardar,
  proyectarSnapshot,
  validarCambios,
  validarTransicion,
} from './reglas-transicion-fiscal';

const RUC = '20610206337';
const CONFIRMACION: ConfirmacionNoOse = { id_usuario: 7, nombre: 'Moisés', fecha: '2026-10-13T15:00:00.000Z', ip: '10.0.0.1' };

/** Aplica el PUT completo como lo hace GestorConfigFiscalService, con los hechos dados para el futuro. */
function aplicar(actual: SnapshotConfigFiscal, dto: ActualizarConfigFiscalDto, hechos: Partial<HechosPreparacion> = {}) {
  const cambios = cambiosDesdeDto(dto, actual.emisor.ruc);
  const futuro = proyectarSnapshot(actual, cambios, CONFIRMACION);
  validarCambios(cambios, futuro);
  const preparacion = evaluarPreparacion(
    hechosPrueba({ ...hechos, snapshot: futuro, claveSol: cambios.solClave ? 'ok' : (hechos.claveSol ?? 'ok') }),
  );
  const { advertencias } = validarTransicion(actual, futuro, preparacion);
  return { cambios, futuro, advertencias, pares: paresParaGuardar(cambios, futuro), eventos: eventosAuditoria(actual, futuro, cambios) };
}

function error(fn: () => unknown): FiscalConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FiscalConfigError) return e;
    throw e;
  }
  throw new Error('se esperaba un FiscalConfigError');
}

const SIN_CONFIRMAR = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_confirmacion_no_ose: '' });
const EN_BETA = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_ambiente: 'beta', fiscal_confirmacion_no_ose: '' });
const ACTIVO = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo' });

describe('reglas de transición del PUT /fiscal/configuracion', () => {
  it('activa SUNAT directo en el mismo PUT con producción + confirmación cuando el checklist está completo', () => {
    const r = aplicar(EN_BETA, { proveedor: 'sunat_directo', ambiente: 'produccion', confirmo_no_ose: true });
    expect(r.futuro.proveedor).toBe('sunat_directo');
    expect(r.pares).toMatchObject({ fiscal_proveedor: 'sunat_directo', fiscal_ambiente: 'produccion' });
    expect(JSON.parse(r.pares.fiscal_confirmacion_no_ose)).toMatchObject({ id_usuario: 7, nombre: 'Moisés' });
    expect(r.eventos.map((e) => e.accion)).toEqual(['PROVEEDOR_CAMBIADO', 'AMBIENTE_CAMBIADO', 'CONFIRMACION_NO_OSE']);
    expect(r.advertencias.join(' ')).toMatch(/directo a SUNAT/);
  });

  it('no activa SUNAT directo con ambiente BETA (las ventas reales nunca van a BETA)', () => {
    const e = error(() => aplicar(EN_BETA, { proveedor: 'sunat_directo', confirmo_no_ose: true }));
    expect(e.codigo).toBe('FISCAL_NO_LISTO');
    expect(e.estadoHttp).toBe(409);
    expect(e.cuerpo()).toMatchObject({ faltantes: ['ambiente_produccion'], checklist: 'cpe' });
  });

  it('sin la confirmación de no OSE responde FISCAL_NO_LISTO con ese faltante y la lista de pendientes', () => {
    const e = error(() => aplicar(SIN_CONFIRMAR, { proveedor: 'sunat_directo' }));
    expect(e.cuerpo()).toMatchObject({ codigo: 'FISCAL_NO_LISTO', faltantes: ['confirmacion_no_ose'] });
    expect((e.cuerpo().items as Array<{ codigo: string }>).map((i) => i.codigo)).toEqual(['confirmacion_no_ose']);
  });

  it('con el checklist incompleto no activa y devuelve todos los faltantes', () => {
    const e = error(() =>
      aplicar(SIN_CONFIRMAR, { proveedor: 'sunat_directo', confirmo_no_ose: true }, { certificados: { beta: null, produccion: null }, claveSol: 'falta' }),
    );
    expect(e.cuerpo().faltantes).toEqual(expect.arrayContaining(['certificado_produccion', 'clave_sol']));
  });

  it('pasar a producción exige el certificado de producción vigente', () => {
    const e = error(() => aplicar(EN_BETA, { ambiente: 'produccion' }, { certificados: { beta: null, produccion: null } }));
    expect(e.cuerpo()).toMatchObject({ codigo: 'FISCAL_NO_LISTO', faltantes: ['certificado_produccion'] });
    expect(e.message).toMatch(/certificado digital de producción/);
    // Con certificado sí se puede (aunque falte, p. ej., la clave SOL: eso solo bloquea la activación).
    expect(aplicar(EN_BETA, { ambiente: 'produccion' }, { claveSol: 'falta' }).futuro.ambiente).toBe('produccion');
  });

  it('desactivar la emisión de producción siempre se permite y avisa que las ventas quedan sin comprobante', () => {
    const r = aplicar(ACTIVO, { proveedor: 'nubefact' }, { certificados: { beta: null, produccion: null } });
    expect(r.futuro.proveedor).toBe('nubefact');
    expect(r.advertencias.join(' ')).toMatch(/sin comprobante/);
    expect(r.advertencias.join(' ')).not.toMatch(/Nubefact/i);
  });

  it('ningún mensaje de la transición manda a «volver a Nubefact»', () => {
    const enBeta = error(() => aplicar(EN_BETA, { proveedor: 'sunat_directo', confirmo_no_ose: true }));
    const incompleto = error(() => aplicar(ACTIVO, { confirmo_no_ose: false }));
    expect(`${enBeta.message} ${incompleto.message}`).not.toMatch(/Nubefact/i);
    expect(incompleto.message).toMatch(/desactive la emisión/);
  });

  it('pasar a producción exige que el certificado sea del RUC del emisor', () => {
    const otroRuc = { beta: null, produccion: certificadoPrueba({ ruc: '20100070970' }) };
    const e = error(() => aplicar(EN_BETA, { ambiente: 'produccion' }, { certificados: otroRuc }));
    expect(e.cuerpo()).toMatchObject({ codigo: 'FISCAL_NO_LISTO', faltantes: ['ruc_certificado'] });
  });

  it('activar exige las 4 confirmaciones de SOL (D1.4) y el correlativo inicial revisado', () => {
    const sinConfirmar = snapshotPrueba({
      ...VALORES_COMPLETOS,
      fiscal_confirma_certificado_en_sol: '',
      fiscal_confirma_ruc_habido: '',
      fiscal_cpe_correlativo_inicial: '',
    });
    const e = error(() => aplicar(sinConfirmar, { proveedor: 'sunat_directo' }));
    expect(e.cuerpo().faltantes).toEqual(['correlativo_inicial', 'confirmacion.certificado_en_sol', 'confirmacion.ruc_habido']);

    const r = aplicar(sinConfirmar, {
      proveedor: 'sunat_directo',
      correlativo_inicial: { F001: 1 },
      confirmaciones: { certificado_en_sol: true, ruc_habido: true },
    });
    expect(r.futuro.proveedor).toBe('sunat_directo');
    expect(r.pares).toMatchObject({
      fiscal_confirma_certificado_en_sol: 'true',
      fiscal_confirma_ruc_habido: 'true',
      fiscal_cpe_correlativo_inicial: '{"F001":1}',
    });
    expect(r.eventos.map((ev) => ev.accion)).toEqual(['PROVEEDOR_CAMBIADO', 'CONFIRMACIONES_ACTIVACION', 'CORRELATIVO_INICIAL_CPE']);
  });

  it('un certificado sin RUC legible solo se acepta con la confirmación del administrador (auditada)', () => {
    const sinRuc = { beta: null, produccion: certificadoPrueba({ ruc: null }) };
    const e = error(() => aplicar(SIN_CONFIRMAR, { proveedor: 'sunat_directo', confirmo_no_ose: true }, { certificados: sinRuc }));
    expect(e.cuerpo().faltantes).toEqual(['cert_ruc_confirmado']);

    const r = aplicar(SIN_CONFIRMAR, { proveedor: 'sunat_directo', confirmo_no_ose: true, cert_ruc_confirmado: true }, { certificados: sinRuc });
    expect(r.pares).toMatchObject({ fiscal_cert_ruc_confirmado_produccion: 'true' });
    expect(r.eventos.find((ev) => ev.accion === 'CERT_RUC_CONFIRMADO')).toMatchObject({ detalle: { de: false, a: true, ruc_emisor: RUC } });
    // Con la emisión activa no se puede retirar; sin ella, retirarla deja la clave vacía.
    expect(error(() => aplicar(r.futuro, { cert_ruc_confirmado: false }, { certificados: sinRuc })).cuerpo().faltantes).toEqual([
      'cert_ruc_confirmado',
    ]);
    const confirmadoInactivo = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_cert_ruc_confirmado_produccion: 'true' });
    expect(aplicar(confirmadoInactivo, { cert_ruc_confirmado: false }, { certificados: sinRuc }).pares).toEqual({
      fiscal_cert_ruc_confirmado_produccion: '',
    });
  });

  it('el correlativo inicial se combina por serie y solo admite series configuradas', () => {
    const conInicial = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_cpe_correlativo_inicial: '{"F001":120}' });
    const r = aplicar(conInicial, { correlativo_inicial: { b001: 35 } as Record<string, number> });
    expect(r.futuro.correlativoInicialCpe).toEqual({ F001: 120, B001: 35 });
    expect(r.pares).toEqual({ fiscal_cpe_correlativo_inicial: '{"F001":120,"B001":35}' });
    expect(r.eventos[0]).toMatchObject({ accion: 'CORRELATIVO_INICIAL_CPE', detalle: { cambios: { B001: { de: 1, a: 35 } } } });

    const e = error(() => aplicar(conInicial, { correlativo_inicial: { FFF1: 40 } }));
    expect(e.codigo).toBe('FISCAL_CONFIG_INVALIDA');
    expect(e.message).toMatch(/FFF1/);
  });

  it('estando activo, un cambio que deja el checklist incompleto se rechaza', () => {
    const e = error(() => aplicar(ACTIVO, { emisor: { ubigeo: undefined, direccion: '   ' } as any }));
    expect(e.codigo).toBe('FISCAL_NO_LISTO');
    expect(e.cuerpo().faltantes).toEqual(['emisor.direccion']);
    expect(error(() => aplicar(ACTIVO, { confirmo_no_ose: false })).cuerpo().faltantes).toEqual(['confirmacion_no_ose']);
    expect(error(() => aplicar(ACTIVO, { ambiente: 'beta' })).cuerpo().faltantes).toEqual(['ambiente_produccion']);
  });

  it('activar la GRE exige su propio checklist (credenciales API, serie T y punto de partida)', () => {
    const e = error(() => aplicar(ACTIVO, { gre: { activa: true } }, { credencialesGre: 'falta' }));
    expect(e.cuerpo()).toMatchObject({ checklist: 'gre', faltantes: ['gre.credenciales_api'] });

    const r = aplicar(ACTIVO, { gre: { activa: true, correlativo_inicial: 16, partida: { ubigeo: '150103', direccion: 'ALMACEN 2' } } });
    expect(r.pares).toMatchObject({
      fiscal_gre_activa: 'true',
      fiscal_gre_correlativo_inicial: '16',
      fiscal_gre_partida_ubigeo: '150103',
      fiscal_gre_partida_direccion: 'ALMACEN 2',
    });
    expect(r.eventos.map((ev) => ev.accion)).toEqual(['CONFIG_GRE']);
    expect(error(() => aplicar(EN_BETA, { gre: { activa: true } })).cuerpo().faltantes).toEqual(['ambiente_produccion']);
  });

  it('las series repetidas son un error de forma (FISCAL_CONFIG_INVALIDA)', () => {
    const e = error(() => aplicar(EN_BETA, { series: { nc_factura: 'F001' } }));
    expect(e.codigo).toBe('FISCAL_CONFIG_INVALIDA');
    expect(e.message).toMatch(/repetida/);
    const r = aplicar(EN_BETA, { series: { factura: 'f002', gre_remitente: 't003' } });
    expect(r.pares).toEqual({ fiscal_serie_factura: 'F002', fiscal_serie_gre_remitente: 'T003' });
    expect(r.eventos[0]).toMatchObject({ accion: 'SERIES', detalle: { cambios: { factura: { de: 'F001', a: 'F002' } } } });
  });

  it('normaliza el usuario SOL (quita el RUC) y valida la clave sin dejarla en la auditoría', () => {
    const r = aplicar(EN_BETA, { sol: { usuario: `${RUC}hatun002`, clave: 'Secreta#12' } });
    expect(r.cambios.solUsuario).toBe('HATUN002');
    expect(r.pares).toEqual({ fiscal_sol_usuario: 'HATUN002' });
    expect(JSON.stringify(r.eventos)).not.toContain('Secreta#12');
    expect(r.eventos[0]).toMatchObject({ accion: 'CRED_SOL_ACTUALIZADA', detalle: { clave_actualizada: true } });

    expect(error(() => cambiosDesdeDto({ sol: { usuario: 'HATUN001', clave: ' corta ' } }, RUC)).codigo).toBe('FISCAL_CONFIG_INVALIDA');
    expect(error(() => cambiosDesdeDto({ sol: { usuario: `20100070970HATUN001` } }, RUC)).codigo).toBe('FISCAL_CONFIG_INVALIDA');
  });

  it('el distrito/provincia/departamento también actualizan emisor_ubicacion (pantalla actual)', () => {
    const r = aplicar(EN_BETA, { emisor: { distrito: 'PACHACAMAC', ubigeo: '150123' } });
    expect(r.pares).toMatchObject({
      emisor_distrito: 'PACHACAMAC',
      emisor_ubigeo: '150123',
      emisor_ubicacion: 'PACHACAMAC - LIMA - LIMA',
    });
    // La partida heredada sigue al emisor nuevo en el mismo PUT.
    expect(r.futuro.gre.partida.ubigeo).toBe('150123');
  });

  it('vaciar un campo de la partida vuelve a heredarlo del emisor', () => {
    const conPartida = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_gre_partida_ubigeo: '150101' });
    const r = aplicar(conPartida, { gre: { partida: { ubigeo: '' } } });
    expect(r.pares).toEqual({ fiscal_gre_partida_ubigeo: '' });
    expect(r.futuro.gre.partida.ubigeo).toBe('150119');
    expect(r.futuro.gre.partidaHeredada.ubigeo).toBe(true);
  });

  it('un PUT sin cambios no escribe nada ni audita', () => {
    const r = aplicar(EN_BETA, {});
    expect(r.pares).toEqual({});
    expect(r.eventos).toEqual([]);
  });
});
