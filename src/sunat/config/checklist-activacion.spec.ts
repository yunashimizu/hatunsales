import { evaluarPreparacion } from './checklist-activacion';
import { AHORA_PRUEBA, certificadoPrueba, hechosPrueba, snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';

const DIA = 24 * 3600 * 1000;

describe('checklist de activación por tipo de documento', () => {
  it('con todo configurado, factura/boleta/notas y GRE quedan listas', () => {
    const resultado = evaluarPreparacion(hechosPrueba());
    expect(resultado.listo).toBe(true);
    expect(resultado.faltantes).toEqual([]);
    expect(resultado.checklist.cpe.listo).toBe(true);
    expect(resultado.checklist.gre.listo).toBe(true);
    expect(resultado.checklist.cpe.items.every((i) => i.ok && i.detalle === null)).toBe(true);
    expect(resultado.pruebas_beta.listo).toBe(true);
  });

  it('los checklists son independientes: sin credenciales API solo falla la GRE', () => {
    const resultado = evaluarPreparacion(hechosPrueba({ credencialesGre: 'falta' }));
    expect(resultado.checklist.cpe.listo).toBe(true);
    expect(resultado.checklist.gre.listo).toBe(false);
    expect(resultado.checklist.gre.faltantes).toEqual(['gre.credenciales_api']);
    const item = resultado.checklist.gre.items.find((i) => i.codigo === 'gre.credenciales_api');
    expect(item?.accion).toMatch(/Credenciales de API SUNAT/);
  });

  it('sin certificado de producción falta en ambos (sin repetir vencido/autofirmado)', () => {
    const resultado = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: null } }));
    expect(resultado.faltantes).toEqual(['certificado_produccion']);
    expect(resultado.checklist.gre.faltantes).toEqual(['certificado_produccion']);
  });

  it('marca el certificado vencido, autofirmado, de otro RUC o ilegible', () => {
    const vencido = evaluarPreparacion(
      hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ vigenteHasta: new Date(AHORA_PRUEBA.getTime() - DIA) }) } }),
    );
    expect(vencido.faltantes).toContain('certificado_vencido');

    const autofirmado = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ autofirmado: true }) } }));
    expect(autofirmado.faltantes).toContain('certificado_autofirmado');

    const otroRuc = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ ruc: '20100070970' }) } }));
    expect(otroRuc.faltantes).toEqual(['ruc_certificado']);

    const ilegible = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ legible: false }) } }));
    expect(ilegible.faltantes).toEqual(['certificado_produccion']);
    expect(ilegible.checklist.cpe.items.find((i) => i.codigo === 'certificado_produccion')?.detalle).toMatch(/FISCAL_SECRET_KEY/);
  });

  it('sin RUC en el certificado no bloquea: solo advierte', () => {
    const resultado = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ ruc: null }) } }));
    expect(resultado.listo).toBe(true);
    expect(resultado.advertencias.join(' ')).toMatch(/No se encontró el RUC/);
  });

  it('avisa si el certificado vence en 30 días o menos', () => {
    const resultado = evaluarPreparacion(
      hechosPrueba({ certificados: { beta: null, produccion: certificadoPrueba({ vigenteHasta: new Date(AHORA_PRUEBA.getTime() + 10 * DIA) }) } }),
    );
    expect(resultado.listo).toBe(true);
    expect(resultado.advertencias.join(' ')).toMatch(/vence en 10 día/);
  });

  it('pide llave, migración, usuario y clave SOL con mensajes claros', () => {
    const resultado = evaluarPreparacion(
      hechosPrueba({
        cifradoDisponible: false,
        esquema: { listo: false, faltantes: ['tabla fiscal_certificados'] },
        claveSol: 'ilegible',
        snapshot: snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_sol_usuario: '' }),
      }),
    );
    expect(resultado.faltantes).toEqual(expect.arrayContaining(['FISCAL_SECRET_KEY', 'migracion_fase9', 'usuario_sol', 'clave_sol']));
    const migracion = resultado.checklist.cpe.items.find((i) => i.codigo === 'migracion_fase9');
    expect(migracion?.detalle).toMatch(/sql\/fase9_sunat_directo\.sql/);
    expect(resultado.checklist.cpe.items.find((i) => i.codigo === 'clave_sol')?.detalle).toMatch(/descifrar/);
  });

  it('el ubigeo falta en el emisor y, por herencia, en el punto de partida de la GRE', () => {
    const resultado = evaluarPreparacion(hechosPrueba({ snapshot: snapshotPrueba({ ...VALORES_COMPLETOS, emisor_ubigeo: '' }) }));
    expect(resultado.faltantes).toEqual(['emisor.ubigeo']);
    expect(resultado.checklist.gre.faltantes).toEqual(['gre.partida.ubigeo']);
  });

  it('un punto de partida propio completa la GRE aunque el emisor no tenga ubigeo', () => {
    const resultado = evaluarPreparacion(
      hechosPrueba({ snapshot: snapshotPrueba({ ...VALORES_COMPLETOS, emisor_ubigeo: '', fiscal_gre_partida_ubigeo: '150101' }) }),
    );
    expect(resultado.checklist.gre.listo).toBe(true);
    expect(resultado.checklist.cpe.listo).toBe(false);
  });

  it('las series de comprobantes deben ser distintas', () => {
    const resultado = evaluarPreparacion(
      hechosPrueba({ snapshot: snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_serie_nc_factura: 'F001' }) }),
    );
    expect(resultado.faltantes).toEqual(['series']);
    expect(resultado.checklist.cpe.items.find((i) => i.codigo === 'series')?.detalle).toMatch(/repetida/);
    expect(resultado.checklist.gre.listo).toBe(true);
  });

  it('exige la confirmación de no tener OSE en ambos documentos', () => {
    const resultado = evaluarPreparacion(hechosPrueba({ snapshot: snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_confirmacion_no_ose: '' }) }));
    expect(resultado.faltantes).toEqual(['confirmacion_no_ose']);
    expect(resultado.checklist.gre.faltantes).toEqual(['confirmacion_no_ose']);
  });

  it('las pruebas en BETA solo necesitan llave, migración y un certificado (el de producción sirve)', () => {
    const conProduccion = evaluarPreparacion(hechosPrueba({ claveSol: 'falta', credencialesGre: 'falta' }));
    expect(conProduccion.pruebas_beta).toEqual({ listo: true, faltantes: [] });
    const sinCertificado = evaluarPreparacion(hechosPrueba({ certificados: { beta: null, produccion: null } }));
    expect(sinCertificado.pruebas_beta.faltantes).toEqual(['certificado_beta']);
  });
});
