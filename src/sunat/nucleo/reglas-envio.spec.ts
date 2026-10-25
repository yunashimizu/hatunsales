import {
  admiteGetStatusCdr,
  esDocumentoDeFactura,
  fechaLimiteEnvioIndividual,
  rucDeUsuarioSol,
  usuarioSolCorrespondeAlEmisor,
} from './reglas-envio';

describe('reglas de envío', () => {
  describe('admiteGetStatusCdr: solo facturas y sus notas (01, 07, 08) con serie F', () => {
    it.each([
      ['01', 'F001', true],
      ['01', 'FFF1', true],
      ['01', 'FB01', true],
      ['07', 'FC01', true],
      ['07', 'FBC1', true],
      ['08', 'FD01', true],
      ['08', 'FBD1', true],
      ['01', 'f001', true],
      ['03', 'B001', false],
      ['03', 'F001', false],
      ['07', 'BC01', false],
      ['07', 'BBC1', false],
      ['08', 'BD01', false],
      ['08', 'BBD1', false],
      ['01', 'B001', false],
      ['09', 'T001', false],
      ['01', '', false],
    ] as const)('tipo %s serie %s → %s', (tipo, serie, esperado) => {
      expect(admiteGetStatusCdr(tipo, serie)).toBe(esperado);
    });

    it('tolera una serie ausente', () => {
      expect(admiteGetStatusCdr('01', undefined as unknown as string)).toBe(false);
      expect(admiteGetStatusCdr('01', null as unknown as string)).toBe(false);
    });
  });

  describe('esDocumentoDeFactura: la nota sigue la letra de su serie', () => {
    it.each([
      ['01', 'F001', true],
      ['01', 'B001', true],
      ['03', 'B001', false],
      ['03', 'F001', false],
      ['07', 'FC01', true],
      ['07', 'FBC1', true],
      ['07', 'BC01', false],
      ['07', 'BBC1', false],
      ['08', 'FD01', true],
      ['08', 'FBD1', true],
      ['08', 'BD01', false],
      ['08', 'BBD1', false],
      ['07', '', false],
    ] as const)('tipo %s serie %s → %s', (tipo, serie, esperado) => {
      expect(esDocumentoDeFactura(tipo, serie)).toBe(esperado);
    });
  });

  describe('fechaLimiteEnvioIndividual: 3 días para facturas y sus notas, 5 para boletas y sus notas (desde el día siguiente)', () => {
    it.each([
      ['01', 'F001', '2026-10-21', '2026-10-24'],
      ['03', 'B001', '2026-10-21', '2026-10-26'],
      ['07', 'FC01', '2026-10-21', '2026-10-24'],
      ['07', 'BC01', '2026-10-21', '2026-10-26'],
      ['08', 'FD01', '2026-10-21', '2026-10-24'],
      ['08', 'BD01', '2026-10-21', '2026-10-26'],
      ['07', 'FBC1', '2026-10-21', '2026-10-24'],
      ['07', 'BBC1', '2026-10-21', '2026-10-26'],
    ] as const)('tipo %s serie %s emitido el %s → %s', (tipo, serie, emision, limite) => {
      expect(fechaLimiteEnvioIndividual(tipo, serie, emision)).toBe(limite);
    });

    it.each([
      ['01', 'F001', '2026-10-30', '2026-11-02'],
      ['03', 'B001', '2026-10-29', '2026-11-03'],
      ['01', 'F001', '2026-12-30', '2027-01-02'],
      ['03', 'B001', '2026-12-29', '2027-01-03'],
      ['07', 'BC01', '2026-12-31', '2027-01-05'],
      ['01', 'F001', '2027-02-27', '2027-03-02'],
      ['03', 'B001', '2028-02-26', '2028-03-02'],
      ['01', 'F001', '2028-02-28', '2028-03-02'],
    ] as const)('cruza mes o año: tipo %s serie %s emitido el %s → %s', (tipo, serie, emision, limite) => {
      expect(fechaLimiteEnvioIndividual(tipo, serie, emision)).toBe(limite);
    });

    it('rechaza una fecha que no existe', () => {
      expect(() => fechaLimiteEnvioIndividual('01', 'F001', '2026-02-30')).toThrow('Fecha inválida');
      expect(() => fechaLimiteEnvioIndividual('03', 'B001', '21/10/2026')).toThrow('Fecha inválida');
    });
  });

  describe('usuario SOL: RUC (11 dígitos) + usuario secundario', () => {
    it.each([
      ['20610206337MODDATOS', '20610206337'],
      ['20610206337HATUN01', '20610206337'],
      ['20610206337moddatos', '20610206337'],
      ['  20610206337USUARIO1  ', '20610206337'],
      ['206102063370', '20610206337'],
    ])('%j → %s', (usuario, ruc) => {
      expect(rucDeUsuarioSol(usuario)).toBe(ruc);
    });

    it.each([
      ['20610206337'],
      ['2061020633MODDATOS'],
      ['MODDATOS'],
      ['20610206337 MODDATOS'],
      ['20610206337-MODDATOS'],
      ['20610206337USUARIOÑ'],
      [''],
    ])('%j no es un usuario SOL válido', (usuario) => {
      expect(rucDeUsuarioSol(usuario)).toBeNull();
    });

    it('tolera null y undefined', () => {
      expect(rucDeUsuarioSol(null as unknown as string)).toBeNull();
      expect(rucDeUsuarioSol(undefined as unknown as string)).toBeNull();
    });

    it('usuarioSolCorrespondeAlEmisor compara el RUC del usuario con el del emisor', () => {
      expect(usuarioSolCorrespondeAlEmisor('20610206337HATUN01', '20610206337')).toBe(true);
      expect(usuarioSolCorrespondeAlEmisor(' 20610206337HATUN01 ', ' 20610206337 ')).toBe(true);
      expect(usuarioSolCorrespondeAlEmisor('20614736420MODDATOS', '20610206337')).toBe(false);
      expect(usuarioSolCorrespondeAlEmisor('MODDATOS', '20610206337')).toBe(false);
      expect(usuarioSolCorrespondeAlEmisor('20610206337HATUN01', '')).toBe(false);
      expect(usuarioSolCorrespondeAlEmisor(undefined as unknown as string, undefined as unknown as string)).toBe(false);
    });
  });
});
