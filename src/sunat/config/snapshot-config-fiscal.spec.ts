import { DEFECTOS_PRUEBA } from './configuracion.prueba-spec';
import { construirSnapshot, defectosDesdeEntorno, partirUbicacion } from './snapshot-config-fiscal';

describe('construirSnapshot', () => {
  it('sin nada guardado: Nubefact, BETA, series por defecto y GRE apagada (comportamiento de hoy)', () => {
    const s = construirSnapshot({}, DEFECTOS_PRUEBA);
    expect(s.proveedor).toBe('nubefact');
    expect(s.ambiente).toBe('beta');
    expect(s.series).toEqual({
      factura: 'F001',
      boleta: 'B001',
      nc_factura: 'FC01',
      nc_boleta: 'BC01',
      nd_factura: 'FD01',
      nd_boleta: 'BD01',
      gre_remitente: 'T001',
    });
    expect(s.gre).toMatchObject({ activa: false, serie: 'T001', correlativoInicial: 1 });
    expect(s.emisor).toMatchObject({ distrito: 'LURIN', provincia: 'LIMA', departamento: 'LIMA', codigoEstablecimiento: '0000' });
  });

  it('valores mal escritos caen en valores seguros (nunca activan SUNAT directo por accidente)', () => {
    const s = construirSnapshot(
      {
        fiscal_proveedor: 'SUNAT',
        fiscal_ambiente: 'prod',
        fiscal_serie_gre_remitente: 'G001',
        fiscal_gre_activa: 'quizas',
        fiscal_gre_correlativo_inicial: '-5',
        fiscal_sol_usuario: 'corto',
      },
      DEFECTOS_PRUEBA,
    );
    expect(s.proveedor).toBe('nubefact');
    expect(s.ambiente).toBe('beta');
    expect(s.series.gre_remitente).toBe('T001');
    expect(s.gre.activa).toBe(false);
    expect(s.gre.correlativoInicial).toBe(1);
    expect(s.solUsuario).toBeNull();
  });

  it('el punto de partida de la GRE hereda del emisor salvo lo configurado', () => {
    const heredado = construirSnapshot({ emisor_ubigeo: '150119' }, DEFECTOS_PRUEBA);
    expect(heredado.gre.partida).toEqual({
      ubigeo: '150119',
      direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
      codigoEstablecimiento: '0000',
    });
    expect(heredado.gre.partidaHeredada).toEqual({ ubigeo: true, direccion: true, codigoEstablecimiento: true });

    const propio = construirSnapshot(
      {
        emisor_ubigeo: '150119',
        fiscal_gre_partida_ubigeo: '150103',
        fiscal_gre_partida_direccion: 'AV. ALMACEN 123',
        fiscal_gre_partida_codigo_establecimiento: '0001',
        fiscal_gre_activa: 'true',
        fiscal_gre_correlativo_inicial: '57',
        fiscal_serie_gre_remitente: 't002',
      },
      DEFECTOS_PRUEBA,
    );
    expect(propio.gre).toMatchObject({
      activa: true,
      serie: 'T002',
      correlativoInicial: 57,
      partida: { ubigeo: '150103', direccion: 'AV. ALMACEN 123', codigoEstablecimiento: '0001' },
      partidaHeredada: { ubigeo: false, direccion: false, codigoEstablecimiento: false },
    });
  });

  it('la confirmación de no OSE solo cuenta si es un JSON con fecha', () => {
    expect(construirSnapshot({ fiscal_confirmacion_no_ose: 'true' }, DEFECTOS_PRUEBA).confirmacionNoOse).toBeNull();
    const conFecha = construirSnapshot(
      { fiscal_confirmacion_no_ose: JSON.stringify({ id_usuario: 3, nombre: 'Ana', fecha: '2026-10-01T00:00:00Z' }) },
      DEFECTOS_PRUEBA,
    );
    expect(conFecha.confirmacionNoOse).toMatchObject({ id_usuario: 3, nombre: 'Ana' });
  });

  it('las variables antiguas solo dan valores iniciales (incluida la serie de guía)', () => {
    const defectos = defectosDesdeEntorno({ SUNAT_SERIE_GUIA: 't005', SUNAT_FISCAL_ENVIRONMENT: 'produccion' } as NodeJS.ProcessEnv);
    const s = construirSnapshot({}, defectos);
    expect(s.series.gre_remitente).toBe('T005');
    expect(s.ambiente).toBe('produccion');
    expect(construirSnapshot({ fiscal_serie_gre_remitente: 'T009' }, defectos).series.gre_remitente).toBe('T009');
  });

  it('parte la ubicación «DISTRITO - PROVINCIA - DEPARTAMENTO»', () => {
    expect(partirUbicacion('LURIN - LIMA - LIMA')).toEqual({ distrito: 'LURIN', provincia: 'LIMA', departamento: 'LIMA' });
    expect(partirUbicacion('LURIN')).toEqual({ distrito: '', provincia: '', departamento: '' });
  });
});
