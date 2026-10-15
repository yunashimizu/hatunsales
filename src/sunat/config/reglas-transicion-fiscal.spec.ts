import { evaluarPreparacion, HechosPreparacion } from './checklist-activacion';
import { hechosPrueba, snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
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
function aplicar(
  actual: SnapshotConfigFiscal,
  dto: ActualizarConfigFiscalDto,
  hechos: Partial<HechosPreparacion> = {},
  nubefactConfigurado = true,
) {
  const cambios = cambiosDesdeDto(dto, actual.emisor.ruc);
  const futuro = proyectarSnapshot(actual, cambios, CONFIRMACION);
  validarCambios(cambios, futuro);
  const preparacion = evaluarPreparacion(
    hechosPrueba({ ...hechos, snapshot: futuro, claveSol: cambios.solClave ? 'ok' : (hechos.claveSol ?? 'ok') }),
  );
  const { advertencias } = validarTransicion(actual, futuro, preparacion, cambios, { nubefactConfigurado });
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

  it('volver a Nubefact siempre se permite (rollback) y avisa si Nubefact no está configurado', () => {
    const r = aplicar(ACTIVO, { proveedor: 'nubefact' }, { certificados: { beta: null, produccion: null } }, false);
    expect(r.futuro.proveedor).toBe('nubefact');
    expect(r.advertencias.join(' ')).toMatch(/NUBEFACT_URL/);
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
