import { Inject, Injectable, Optional } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { ErroresFiscales, FiscalConfigError } from '../config/fiscal-errores';
import { interpretarLlaveMaestra } from './llave-maestra';

/** Origen de las llaves; por defecto, las variables de entorno. Se inyecta en pruebas. */
export const FUENTE_LLAVES_FISCALES = Symbol('FUENTE_LLAVES_FISCALES');
export interface FuenteLlavesFiscales {
  actual?: string | null;
  anterior?: string | null;
}

export interface DiagnosticoCifrado {
  disponible: boolean;
  /** true si FISCAL_SECRET_KEY existe aunque sea inválida. */
  configurada: boolean;
  /** Hay FISCAL_SECRET_KEY_ANTERIOR válida (rotación en curso). */
  rotacion: boolean;
  problema: string | null;
}

export interface ResultadoDescifrado {
  plano: Buffer;
  /** Se abrió con FISCAL_SECRET_KEY_ANTERIOR: conviene volver a cifrar con la actual. */
  conLlaveAnterior: boolean;
}

/**
 * Cifrado autenticado AES-256-GCM para los secretos fiscales (.pfx, su
 * contraseña y la clave SOL).
 *
 * Formato: 0x01 | IV (12 bytes aleatorios) | TAG (16) | CIPHERTEXT.
 * AAD = "hatunsales:fiscal:<contexto>": un texto cifrado solo abre en la fila y
 * el campo para los que se cifró (no se puede intercambiar entre filas).
 * La llave AES se deriva de FISCAL_SECRET_KEY con HKDF-SHA256 (separación de
 * dominio). Nunca se registra la llave ni el texto plano.
 */
@Injectable()
export class CifradoFiscalService {
  static readonly VERSION = 0x01;
  private static readonly LARGO_IV = 12;
  private static readonly LARGO_TAG = 16;
  private static readonly PREFIJO_AAD = 'hatunsales:fiscal:';
  private static readonly SAL_HKDF = Buffer.from('hatunsales/fiscal/v1', 'utf8');
  private static readonly INFO_HKDF = Buffer.from('aes-256-gcm', 'utf8');

  private readonly llaveActual: Buffer | null;
  private readonly llaveAnterior: Buffer | null;
  private readonly diagnosticoInicial: DiagnosticoCifrado;

  constructor(@Optional() @Inject(FUENTE_LLAVES_FISCALES) fuente?: FuenteLlavesFiscales) {
    const origen = fuente ?? {
      actual: process.env.FISCAL_SECRET_KEY,
      anterior: process.env.FISCAL_SECRET_KEY_ANTERIOR,
    };

    const actual = interpretarLlaveMaestra(origen.actual);
    const anterior = interpretarLlaveMaestra(origen.anterior);

    this.llaveActual = actual.estado === 'valida' ? CifradoFiscalService.derivar(actual.llave) : null;
    const derivadaAnterior = anterior.estado === 'valida' ? CifradoFiscalService.derivar(anterior.llave) : null;
    this.llaveAnterior =
      derivadaAnterior && !(this.llaveActual && derivadaAnterior.equals(this.llaveActual)) ? derivadaAnterior : null;

    this.diagnosticoInicial = {
      disponible: this.llaveActual !== null,
      configurada: actual.estado !== 'ausente',
      rotacion: this.llaveAnterior !== null,
      problema:
        actual.estado === 'ausente'
          ? 'FISCAL_SECRET_KEY no está configurada: la emisión electrónica directa queda deshabilitada.'
          : actual.estado === 'invalida'
            ? actual.motivo
            : anterior.estado === 'invalida'
              ? `FISCAL_SECRET_KEY_ANTERIOR se ignora: ${anterior.motivo.replace('FISCAL_SECRET_KEY', 'la llave')}`
              : null,
    };
  }

  disponible(): boolean {
    return this.llaveActual !== null;
  }

  diagnostico(): DiagnosticoCifrado {
    return { ...this.diagnosticoInicial };
  }

  /** 503 FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA si no hay llave válida. */
  exigirDisponible(): void {
    if (!this.llaveActual) throw ErroresFiscales.claveMaestraNoConfigurada(this.diagnosticoInicial.problema);
  }

  cifrar(plano: Buffer, contexto: string): Buffer {
    this.exigirDisponible();
    const iv = randomBytes(CifradoFiscalService.LARGO_IV);
    const cifrador = createCipheriv('aes-256-gcm', this.llaveActual!, iv, {
      authTagLength: CifradoFiscalService.LARGO_TAG,
    });
    cifrador.setAAD(CifradoFiscalService.aad(contexto));
    const cuerpo = Buffer.concat([cifrador.update(plano), cifrador.final()]);
    return Buffer.concat([Buffer.from([CifradoFiscalService.VERSION]), iv, cifrador.getAuthTag(), cuerpo]);
  }

  cifrarTexto(texto: string, contexto: string): Buffer {
    return this.cifrar(Buffer.from(texto, 'utf8'), contexto);
  }

  descifrar(cifrado: Buffer, contexto: string): Buffer {
    return this.descifrarDetallado(cifrado, contexto).plano;
  }

  descifrarTexto(cifrado: Buffer, contexto: string): string {
    const plano = this.descifrar(cifrado, contexto);
    try {
      return plano.toString('utf8');
    } finally {
      plano.fill(0);
    }
  }

  /** Prueba la llave actual y luego la anterior (rotación). */
  descifrarDetallado(cifrado: Buffer, contexto: string): ResultadoDescifrado {
    this.exigirDisponible();
    const minimo = 1 + CifradoFiscalService.LARGO_IV + CifradoFiscalService.LARGO_TAG;
    if (!Buffer.isBuffer(cifrado) || cifrado.length < minimo || cifrado[0] !== CifradoFiscalService.VERSION) {
      throw new FiscalConfigError('FISCAL_SECRETO_ILEGIBLE', 'El secreto guardado está vacío o tiene un formato desconocido.');
    }

    const iv = cifrado.subarray(1, 1 + CifradoFiscalService.LARGO_IV);
    const tag = cifrado.subarray(1 + CifradoFiscalService.LARGO_IV, minimo);
    const cuerpo = cifrado.subarray(minimo);
    const aad = CifradoFiscalService.aad(contexto);

    const candidatas: Array<{ llave: Buffer; anterior: boolean }> = [{ llave: this.llaveActual!, anterior: false }];
    if (this.llaveAnterior) candidatas.push({ llave: this.llaveAnterior, anterior: true });

    for (const { llave, anterior } of candidatas) {
      const plano = CifradoFiscalService.abrir(llave, iv, tag, cuerpo, aad);
      if (plano) return { plano, conLlaveAnterior: anterior };
    }
    throw ErroresFiscales.secretoIlegible('un secreto fiscal guardado');
  }

  private static abrir(llave: Buffer, iv: Buffer, tag: Buffer, cuerpo: Buffer, aad: Buffer): Buffer | null {
    try {
      const descifrador = createDecipheriv('aes-256-gcm', llave, iv, { authTagLength: CifradoFiscalService.LARGO_TAG });
      descifrador.setAAD(aad);
      descifrador.setAuthTag(tag);
      return Buffer.concat([descifrador.update(cuerpo), descifrador.final()]);
    } catch {
      return null; // etiqueta inválida: otra llave, otro contexto o datos alterados
    }
  }

  private static aad(contexto: string): Buffer {
    const limpio = (contexto ?? '').trim();
    if (!limpio || limpio.length > 200) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'Contexto de cifrado inválido.');
    }
    return Buffer.from(CifradoFiscalService.PREFIJO_AAD + limpio, 'utf8');
  }

  private static derivar(maestra: Buffer): Buffer {
    return Buffer.from(
      hkdfSync('sha256', maestra, CifradoFiscalService.SAL_HKDF, CifradoFiscalService.INFO_HKDF, 32),
    );
  }
}
