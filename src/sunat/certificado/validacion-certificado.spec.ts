import { FiscalConfigError } from '../config/fiscal-errores';
import { InfoCertificado } from './certificado-digital.util';
import { validarCertificadoParaUso } from './validacion-certificado';

const AHORA = new Date('2026-10-13T15:00:00Z');
const DIA = 24 * 3600 * 1000;
const RUC = '20610206337';

function info(cambios: Partial<InfoCertificado> = {}): InfoCertificado {
  return {
    titular: 'HATUNSALES S.A.C.',
    ruc: RUC,
    numeroSerie: '5A3F09C1',
    emisor: 'ECEP-RENIEC CA Class 1',
    vigenteDesde: new Date(AHORA.getTime() - 10 * DIA),
    vigenteHasta: new Date(AHORA.getTime() + 1000 * DIA),
    bitsClave: 2048,
    huellaSha256: 'a'.repeat(64),
    autofirmado: false,
    permiteFirma: true,
    ...cambios,
  };
}

const ctx = { ambiente: 'produccion' as const, rucEmisor: RUC, ahora: AHORA, forzar: false };

function error(fn: () => unknown): FiscalConfigError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof FiscalConfigError) return e;
    throw e;
  }
}

describe('validarCertificadoParaUso', () => {
  it('acepta un CDT vigente del mismo RUC sin advertencias', () => {
    expect(validarCertificadoParaUso(info(), ctx)).toEqual({ advertencias: [] });
  });

  it('rechaza un certificado vencido (FISCAL_CERT_VENCIDO, 400)', () => {
    const e = error(() => validarCertificadoParaUso(info({ vigenteHasta: new Date(AHORA.getTime() - DIA) }), ctx));
    expect(e?.codigo).toBe('FISCAL_CERT_VENCIDO');
    expect(e?.estadoHttp).toBe(400);
    expect(e?.message).toMatch(/vencido/);
  });

  it('rechaza uno que aún no rige (más de un día en el futuro) y tolera desfases de reloj', () => {
    expect(error(() => validarCertificadoParaUso(info({ vigenteDesde: new Date(AHORA.getTime() + 3 * DIA) }), ctx))?.codigo).toBe(
      'FISCAL_CERT_VENCIDO',
    );
    expect(error(() => validarCertificadoParaUso(info({ vigenteDesde: new Date(AHORA.getTime() + 3600_000) }), ctx))).toBeNull();
  });

  it('si el RUC del certificado no coincide responde 422 FISCAL_CERT_RUC_NO_COINCIDE (salvo beta con forzar)', () => {
    const e = error(() => validarCertificadoParaUso(info({ ruc: '20100070970' }), ctx));
    expect(e?.codigo).toBe('FISCAL_CERT_RUC_NO_COINCIDE');
    expect(e?.estadoHttp).toBe(422);
    expect(e?.cuerpo()).toMatchObject({ ruc_certificado: '20100070970', ruc_emisor: RUC });

    expect(error(() => validarCertificadoParaUso(info({ ruc: '20100070970' }), { ...ctx, ambiente: 'beta' }))?.codigo).toBe(
      'FISCAL_CERT_RUC_NO_COINCIDE',
    );
    const forzado = validarCertificadoParaUso(info({ ruc: '20100070970' }), { ...ctx, ambiente: 'beta', forzar: true });
    expect(forzado.advertencias.join(' ')).toMatch(/20100070970/);
  });

  it('si el RUC no aparece en el certificado solo advierte', () => {
    const resultado = validarCertificadoParaUso(info({ ruc: null }), ctx);
    expect(resultado.advertencias.join(' ')).toMatch(/No se encontró el RUC/);
  });

  it('un autofirmado no sirve para producción pero sí para BETA (con advertencia)', () => {
    expect(error(() => validarCertificadoParaUso(info({ autofirmado: true }), ctx))?.codigo).toBe('FISCAL_CERT_AUTOFIRMADO');
    const beta = validarCertificadoParaUso(info({ autofirmado: true }), { ...ctx, ambiente: 'beta' });
    expect(beta.advertencias.join(' ')).toMatch(/BETA/);
  });

  it('clave de 1024 bits: advertencia; menos de 1024: FISCAL_CERT_CLAVE_DEBIL', () => {
    expect(validarCertificadoParaUso(info({ bitsClave: 1024 }), ctx).advertencias.join(' ')).toMatch(/1024 bits/);
    expect(error(() => validarCertificadoParaUso(info({ bitsClave: 512 }), ctx))?.codigo).toBe('FISCAL_CERT_CLAVE_DEBIL');
  });

  it('avisa cuando faltan 30 días o menos para que venza', () => {
    const resultado = validarCertificadoParaUso(info({ vigenteHasta: new Date(AHORA.getTime() + 20 * DIA) }), ctx);
    expect(resultado.advertencias.join(' ')).toMatch(/vence en 20 día/);
  });

  it('avisa si el certificado no declara el uso de firma digital', () => {
    expect(validarCertificadoParaUso(info({ permiteFirma: false }), ctx).advertencias.join(' ')).toMatch(/firma digital/);
  });
});
