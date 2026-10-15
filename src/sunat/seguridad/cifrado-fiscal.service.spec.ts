import { randomBytes } from 'crypto';
import { FiscalConfigError } from '../config/fiscal-errores';
import { CifradoFiscalService } from './cifrado-fiscal.service';
import { interpretarLlaveMaestra } from './llave-maestra';

const LLAVE = randomBytes(32).toString('base64');
const OTRA = randomBytes(32).toString('base64');

function codigoDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FiscalConfigError ? error.codigo : `otro: ${(error as Error).message}`;
  }
}

describe('CifradoFiscalService (AES-256-GCM)', () => {
  const servicio = new CifradoFiscalService({ actual: LLAVE });

  it('cifra y descifra ida y vuelta (binario y texto) con el formato 0x01|IV|TAG|CIPHERTEXT', () => {
    const plano = randomBytes(3000);
    const cifrado = servicio.cifrar(plano, 'cert:pfx:produccion:abc');
    expect(cifrado[0]).toBe(0x01);
    expect(cifrado.length).toBe(1 + 12 + 16 + plano.length);
    expect(servicio.descifrar(cifrado, 'cert:pfx:produccion:abc').equals(plano)).toBe(true);

    const texto = servicio.cifrarTexto('ClaveSol#2026', 'secreto:sol_clave');
    expect(texto.toString('utf8')).not.toContain('ClaveSol');
    expect(servicio.descifrarTexto(texto, 'secreto:sol_clave')).toBe('ClaveSol#2026');
  });

  it('usa un IV aleatorio: el mismo texto cifra distinto cada vez', () => {
    const a = servicio.cifrarTexto('igual', 'secreto:sol_clave');
    const b = servicio.cifrarTexto('igual', 'secreto:sol_clave');
    expect(a.equals(b)).toBe(false);
  });

  it('detecta cualquier manipulación (IV, etiqueta o contenido) con FISCAL_SECRETO_ILEGIBLE', () => {
    const cifrado = servicio.cifrarTexto('secreto', 'secreto:sol_clave');
    for (const posicion of [1, 13, 1 + 12 + 16]) {
      const alterado = Buffer.from(cifrado);
      alterado[posicion] ^= 0xff;
      expect(codigoDe(() => servicio.descifrar(alterado, 'secreto:sol_clave'))).toBe('FISCAL_SECRETO_ILEGIBLE');
    }
  });

  it('ata el cifrado a su contexto (AAD): no se puede usar en otra fila', () => {
    const cifrado = servicio.cifrarTexto('secreto', 'cert:clave:produccion:aaa');
    expect(codigoDe(() => servicio.descifrar(cifrado, 'cert:clave:produccion:bbb'))).toBe('FISCAL_SECRETO_ILEGIBLE');
    expect(codigoDe(() => servicio.descifrar(cifrado, 'cert:clave:beta:aaa'))).toBe('FISCAL_SECRETO_ILEGIBLE');
  });

  it('rechaza versiones desconocidas, datos vacíos y contextos inválidos', () => {
    const cifrado = servicio.cifrarTexto('x', 'secreto:sol_clave');
    const otraVersion = Buffer.from(cifrado);
    otraVersion[0] = 0x02;
    expect(codigoDe(() => servicio.descifrar(otraVersion, 'secreto:sol_clave'))).toBe('FISCAL_SECRETO_ILEGIBLE');
    expect(codigoDe(() => servicio.descifrar(Buffer.alloc(0), 'secreto:sol_clave'))).toBe('FISCAL_SECRETO_ILEGIBLE');
    expect(codigoDe(() => servicio.cifrarTexto('x', '   '))).toBe('FISCAL_CONFIG_INVALIDA');
  });

  it('con una llave distinta no abre lo cifrado (llave cambiada sin la anterior)', () => {
    const cifrado = servicio.cifrarTexto('x', 'secreto:sol_clave');
    const otro = new CifradoFiscalService({ actual: OTRA });
    expect(codigoDe(() => otro.descifrar(cifrado, 'secreto:sol_clave'))).toBe('FISCAL_SECRETO_ILEGIBLE');
  });

  it('rotación: con FISCAL_SECRET_KEY_ANTERIOR abre lo viejo e indica que conviene re-cifrar', () => {
    const viejo = new CifradoFiscalService({ actual: OTRA }).cifrarTexto('clave-vieja', 'secreto:sol_clave');
    const rotado = new CifradoFiscalService({ actual: LLAVE, anterior: OTRA });
    const resultado = rotado.descifrarDetallado(viejo, 'secreto:sol_clave');
    expect(resultado.plano.toString('utf8')).toBe('clave-vieja');
    expect(resultado.conLlaveAnterior).toBe(true);
    expect(rotado.diagnostico().rotacion).toBe(true);

    const nuevo = rotado.cifrarTexto('clave-nueva', 'secreto:sol_clave');
    expect(rotado.descifrarDetallado(nuevo, 'secreto:sol_clave').conLlaveAnterior).toBe(false);
    expect(servicio.descifrarTexto(nuevo, 'secreto:sol_clave')).toBe('clave-nueva');
  });

  it('sin llave: no está disponible y responde FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA (sin romper el arranque)', () => {
    const sinLlave = new CifradoFiscalService({ actual: undefined });
    expect(sinLlave.disponible()).toBe(false);
    expect(sinLlave.diagnostico()).toMatchObject({ disponible: false, configurada: false });
    expect(codigoDe(() => sinLlave.cifrarTexto('x', 'secreto:sol_clave'))).toBe('FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA');
    expect(codigoDe(() => sinLlave.descifrar(Buffer.alloc(40, 1), 'secreto:sol_clave'))).toBe('FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA');
  });

  it('llave inválida: formato incorrecto o trivial, con un motivo que no revela la llave', () => {
    for (const valor of ['corta', 'x'.repeat(44), Buffer.alloc(32, 0).toString('base64')]) {
      const invalida = new CifradoFiscalService({ actual: valor });
      expect(invalida.disponible()).toBe(false);
      expect(invalida.diagnostico().configurada).toBe(true);
      expect(invalida.diagnostico().problema).toMatch(/FISCAL_SECRET_KEY/);
      expect(invalida.diagnostico().problema).not.toContain(valor);
    }
  });

  it('acepta la llave en base64 (estándar o URL-safe) y en 64 caracteres hex', () => {
    const bytes = randomBytes(32);
    expect(interpretarLlaveMaestra(bytes.toString('base64')).estado).toBe('valida');
    expect(interpretarLlaveMaestra(bytes.toString('base64url')).estado).toBe('valida');
    expect(interpretarLlaveMaestra(bytes.toString('hex')).estado).toBe('valida');
    expect(interpretarLlaveMaestra(`"${bytes.toString('base64')}"`).estado).toBe('valida');
    expect(interpretarLlaveMaestra('').estado).toBe('ausente');
    expect(interpretarLlaveMaestra(randomBytes(16).toString('base64')).estado).toBe('invalida');
  });
});
