import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { extname } from 'path';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CacheTtl } from '../config/cache-ttl';
import type { CertificadoParaChecklist } from '../config/checklist-activacion';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { ActorFiscal, AMBIENTES_FISCALES, AmbienteFiscal } from '../config/fiscal-config.tipos';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { RelojFiscal } from '../config/reloj-fiscal';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGre, CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import {
  CertificadoLeido,
  certificadoPublico,
  FormatoCertificadoPublico,
  generarAutofirmado,
  leerPkcs12,
  normalizarContenidoPkcs12,
} from './certificado-digital.util';
import { RepositorioCertificadosFiscales, FilaCertificadoFiscal, MetadatosCertificadoFiscal } from './certificado-fiscal.repository';
import { CertificadoInfoVista, describirCertificado } from './certificado-info';
import { CredencialesSol, MaterialFirma } from './material-firma';
import { validarCertificadoParaUso } from './validacion-certificado';

/** Lo que entrega multer (memoryStorage): el archivo nunca toca el disco. */
export interface ArchivoCertificado {
  buffer: Buffer;
  originalname?: string;
  size?: number;
  mimetype?: string;
}

export interface OpcionesSubidaCertificado {
  /** Por omisión: produccion para un certificado real, beta para uno autofirmado. */
  ambiente?: AmbienteFiscal;
  /** Solo en beta: aceptar un RUC distinto. */
  forzar?: boolean;
}

export interface CertificadoSubido extends CertificadoInfoVista {
  /** id del certificado que quedó reemplazado (historial), o null. */
  reemplaza_a: number | null;
}

export interface DescargaCertificadoPublico {
  contenido: Buffer;
  mime: string;
  nombreArchivo: string;
}

/** Material descifrado que vive solo en memoria. */
interface MaterialCargado {
  idCertificado: number;
  huella: string;
  material: MaterialFirma;
}

export const TAMANO_MAXIMO_CERTIFICADO = 200 * 1024;
const EXTENSIONES_ACEPTADAS = new Set(['', '.pfx', '.p12']);

/**
 * Certificado digital para firmar (CDT de SUNAT o comprado):
 * subir/reemplazar/eliminar, autofirmado solo para BETA, parte pública para
 * registrarla en SOL y el MaterialFirma que usan la firma de comprobantes y la GRE.
 *
 * El .pfx y su contraseña se guardan cifrados (AES-256-GCM, AAD atado al
 * ambiente y a la huella). Lo descifrado vive solo en memoria 10 minutos; entre
 * instancias, cada 30 s como máximo se compara id+huella con la BD.
 */
@Injectable()
export class CertificadoFiscalService {
  static readonly TTL_MATERIAL_MS = 10 * 60_000;
  static readonly TTL_VERSION_MS = 30_000;

  private readonly logger = new Logger(CertificadoFiscalService.name);
  private readonly cacheMaterial: CacheTtl<MaterialCargado | null>;
  private readonly cacheVersion: CacheTtl<{ id_certificado: number; huella_sha256: string } | null>;

  constructor(
    private readonly repositorio: RepositorioCertificadosFiscales,
    private readonly cifrado: CifradoFiscalService,
    private readonly config: FiscalConfigService,
    private readonly esquema: FiscalEsquemaService,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly transacciones: TransaccionesFiscales,
    private readonly reloj: RelojFiscal,
    private readonly notificador: NotificadorCambiosFiscales,
    private readonly credencialesSol: CredencialesSolService,
    private readonly credencialesGre: CredencialesGreService,
  ) {
    const ahora = () => this.reloj.ms();
    this.cacheMaterial = new CacheTtl<MaterialCargado | null>(CertificadoFiscalService.TTL_MATERIAL_MS, ahora);
    this.cacheVersion = new CacheTtl(CertificadoFiscalService.TTL_VERSION_MS, ahora);
    notificador.suscribir((tipo) => {
      if (tipo === 'certificado') this.invalidar();
    });
  }

  static contextoPfx(ambiente: AmbienteFiscal, huella: string): string {
    return `cert:pfx:${ambiente}:${huella}`;
  }

  static contextoClave(ambiente: AmbienteFiscal, huella: string): string {
    return `cert:clave:${ambiente}:${huella}`;
  }

  // ── Para la firma (núcleo, emisión y GRE) ────────────────────────────────

  /**
   * Material para firmar XML-DSig. En BETA, si no hay certificado de pruebas,
   * se usa el de producción (BETA no valida la cadena). Nunca devuelve un
   * certificado vencido, ni uno autofirmado para producción.
   */
  async obtenerMaterialFirma(ambiente: AmbienteFiscal): Promise<MaterialFirma> {
    const cargado =
      (await this.materialVigente(ambiente)) ?? (ambiente === 'beta' ? await this.materialVigente('produccion') : null);
    if (!cargado) {
      throw new FiscalConfigError(
        'FISCAL_CERT_NO_CARGADO',
        ambiente === 'produccion'
          ? 'No hay certificado digital de producción. Súbalo en Configuración › Facturación electrónica (SUNAT).'
          : 'No hay certificado digital para pruebas. Suba el suyo o genere uno de prueba en el panel.',
      );
    }
    const { material } = cargado;
    if (material.vigenteHasta.getTime() <= this.reloj.ms()) {
      throw new FiscalConfigError('FISCAL_CERT_VENCIDO', 'El certificado digital está vencido: suba uno vigente para seguir firmando.');
    }
    if (ambiente === 'produccion' && material.autofirmado) {
      throw new FiscalConfigError('FISCAL_CERT_AUTOFIRMADO', 'El certificado de producción es autofirmado: SUNAT lo rechazaría.');
    }
    return { ...material };
  }

  /** Material BETA exclusivo; el flujo comercial de pruebas nunca hereda el certificado productivo. */
  async obtenerMaterialFirmaBeta(): Promise<MaterialFirma> {
    const cargado = await this.materialVigente('beta');
    if (!cargado) {
      throw new FiscalConfigError(
        'FISCAL_CERT_NO_CARGADO',
        'No hay certificado digital BETA. Suba el certificado de pruebas en el panel antes de activar el POS BETA.',
      );
    }
    if (cargado.material.vigenteHasta.getTime() <= this.reloj.ms()) {
      throw new FiscalConfigError('FISCAL_CERT_VENCIDO', 'El certificado digital BETA está vencido: suba uno vigente para seguir firmando.');
    }
    return { ...cargado.material };
  }

  /** Contrato §12.2: credenciales SOL del ambiente (BETA = RUC+MODDATOS). */
  obtenerCredencialesSol(ambiente: AmbienteFiscal): Promise<CredencialesSol> {
    return this.credencialesSol.obtener(ambiente);
  }

  /** Para el módulo GRE: client_id/secret de la API de SUNAT + usuario y clave SOL. */
  obtenerCredencialesGre(ambiente: AmbienteFiscal): Promise<CredencialesGre> {
    return this.credencialesGre.obtener(ambiente);
  }

  // ── Consulta (sin secretos) ───────────────────────────────────────────────

  async infoActivo(ambiente: AmbienteFiscal): Promise<CertificadoInfoVista | null> {
    return (await this.infoTodos())[ambiente];
  }

  async infoTodos(): Promise<Record<AmbienteFiscal, CertificadoInfoVista | null>> {
    const resultado: Record<AmbienteFiscal, CertificadoInfoVista | null> = { beta: null, produccion: null };
    if (!(await this.esquema.tiene('secretos'))) return resultado;
    const [metadatos, snapshot] = await Promise.all([this.repositorio.metadatosActivos(), this.config.snapshot()]);
    const contexto = { ahora: this.reloj.ahora(), rucEmisor: snapshot.emisor.ruc };
    for (const meta of metadatos) {
      if (AMBIENTES_FISCALES.includes(meta.ambiente)) resultado[meta.ambiente] = describirCertificado(meta, contexto);
    }
    return resultado;
  }

  /** Hechos para el checklist: metadatos + si el secreto abre con la llave actual. */
  async estadoParaChecklist(): Promise<Record<AmbienteFiscal, CertificadoParaChecklist | null>> {
    const resultado: Record<AmbienteFiscal, CertificadoParaChecklist | null> = { beta: null, produccion: null };
    if (!(await this.esquema.tiene('secretos'))) return resultado;
    const metadatos = await this.repositorio.metadatosActivos();
    for (const meta of metadatos) {
      if (!AMBIENTES_FISCALES.includes(meta.ambiente)) continue;
      resultado[meta.ambiente] = {
        ruc: meta.ruc,
        vigenteDesde: meta.vigente_desde,
        vigenteHasta: meta.vigente_hasta,
        autofirmado: meta.autofirmado,
        bitsClave: meta.bits_clave,
        legible: await this.esLegible(meta.ambiente),
      };
    }
    return resultado;
  }

  // ── Cambios ───────────────────────────────────────────────────────────────

  async subir(
    archivo: ArchivoCertificado | null | undefined,
    clave: string,
    opciones: OpcionesSubidaCertificado,
    actor: ActorFiscal,
  ): Promise<CertificadoSubido> {
    await this.esquema.exigir('secretos');
    this.cifrado.exigirDisponible();
    // El tipo se verifica por el contenido; se guarda siempre el DER normalizado.
    const der = normalizarContenidoPkcs12(this.validarArchivo(archivo));

    const leido = leerPkcs12(der, clave ?? '');
    const ambiente: AmbienteFiscal = opciones.ambiente ?? (leido.info.autofirmado ? 'beta' : 'produccion');
    return this.guardarLeido(leido, der, clave ?? '', {
      ambiente,
      forzar: !!opciones.forzar,
      nombreArchivo: archivo?.originalname ?? null,
      accion: 'subido',
      actor,
    });
  }

  /** Certificado autofirmado (RSA 2048, OU = RUC) SOLO para SUNAT BETA. */
  async generarAutofirmadoBeta(actor: ActorFiscal, dias = 365): Promise<CertificadoSubido> {
    const snapshot = await this.config.snapshotFresco();
    if (snapshot.ambiente !== 'beta') {
      throw new FiscalConfigError(
        'FISCAL_SOLO_BETA',
        'El certificado de prueba solo está disponible con el ambiente BETA. Cambie el ambiente a beta para generarlo.',
      );
    }
    await this.esquema.exigir('secretos');
    this.cifrado.exigirDisponible();

    const clave = randomBytes(18).toString('base64url');
    const pfx = await generarAutofirmado({
      ruc: snapshot.emisor.ruc,
      razonSocial: snapshot.emisor.razonSocial,
      clave,
      dias,
      ahora: this.reloj.ahora(),
    });
    const leido = leerPkcs12(pfx, clave);
    return this.guardarLeido(leido, pfx, clave, {
      ambiente: 'beta',
      forzar: false,
      nombreArchivo: 'autofirmado-beta.pfx',
      accion: 'autofirmado',
      actor,
    });
  }

  /** Retira el certificado vigente del ambiente (queda en el historial, sin secretos). */
  async eliminar(ambiente: AmbienteFiscal, actor: ActorFiscal): Promise<{ eliminado: true; ambiente: AmbienteFiscal; id_certificado: number }> {
    await this.esquema.exigir('secretos');
    const id = await this.transacciones.ejecutar(async (tx) => {
      // Mismo candado que el guardado de la configuración: nadie activa SUNAT directo mientras tanto.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fiscal:config']);
      const snapshot = await this.config.snapshotFresco();
      if (ambiente === 'produccion' && (snapshot.proveedor === 'sunat_directo' || snapshot.gre.activa)) {
        throw new FiscalConfigError(
          'FISCAL_CERT_EN_USO',
          'El certificado de producción está en uso. Primero vuelva a Nubefact (y desactive la GRE electrónica) y luego elimínelo, o súbalo de nuevo para reemplazarlo.',
        );
      }
      const retirado = await this.repositorio.retirarActivo(ambiente, actor.id_usuario, tx);
      if (retirado === null) {
        throw new FiscalConfigError('FISCAL_CERT_NO_CARGADO', `No hay un certificado de ${ambiente} para eliminar.`);
      }
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.CERT_ELIMINADO,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_certificados',
          id_entidad: retirado,
          detalle: { ambiente, usuario: actor.nombre },
          ip: actor.ip,
        },
        tx,
      );
      return retirado;
    });
    this.trasCambio();
    return { eliminado: true, ambiente, id_certificado: id };
  }

  /** Parte pública (.cer) para registrarla en SOL. No requiere descifrar nada. */
  async exportarPublico(ambiente: AmbienteFiscal, formato: FormatoCertificadoPublico): Promise<DescargaCertificadoPublico> {
    await this.esquema.exigir('secretos');
    const meta = (await this.repositorio.metadatosActivos()).find((m) => m.ambiente === ambiente);
    if (!meta?.certificado_pem) {
      throw new FiscalConfigError('FISCAL_CERT_NO_CARGADO', `No hay un certificado de ${ambiente} cargado.`);
    }
    const { contenido, mime, extension } = certificadoPublico(meta.certificado_pem, formato);
    const ruc = (meta.ruc ?? (await this.config.snapshot()).emisor.ruc).replace(/[^0-9]/g, '') || 'emisor';
    const sufijo = formato === 'pem' ? '-base64' : '';
    return { contenido, mime, nombreArchivo: `certificado-${ruc}-${ambiente}${sufijo}.${extension}` };
  }

  invalidar(ambiente?: AmbienteFiscal): void {
    this.cacheMaterial.invalidar(ambiente);
    this.cacheVersion.invalidar(ambiente);
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private validarArchivo(archivo: ArchivoCertificado | null | undefined): Buffer {
    if (!archivo?.buffer?.length) {
      throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'Adjunte el certificado (.pfx o .p12) en el campo «archivo».');
    }
    if (archivo.buffer.length > TAMANO_MAXIMO_CERTIFICADO) {
      throw new FiscalConfigError(
        'FISCAL_CERT_DEMASIADO_GRANDE',
        'El archivo supera 200 KB: un certificado .pfx pesa normalmente menos de 10 KB. Revise que sea el archivo correcto.',
      );
    }
    const extension = extname(archivo.originalname ?? '').toLowerCase();
    if (!EXTENSIONES_ACEPTADAS.has(extension)) {
      if (['.cer', '.crt', '.der', '.pem'].includes(extension)) {
        throw new FiscalConfigError(
          'FISCAL_CERT_SIN_CLAVE_PRIVADA',
          'Ese archivo es solo el certificado público. Suba el .pfx o .p12 que incluye la clave privada.',
        );
      }
      throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'Suba un archivo .pfx o .p12.');
    }
    return archivo.buffer;
  }

  private async guardarLeido(
    leido: CertificadoLeido,
    pfx: Buffer,
    clave: string,
    opciones: {
      ambiente: AmbienteFiscal;
      forzar: boolean;
      nombreArchivo: string | null;
      accion: 'subido' | 'autofirmado';
      actor: ActorFiscal;
    },
  ): Promise<CertificadoSubido> {
    const { ambiente, actor } = opciones;
    const snapshot = await this.config.snapshot();
    const ahora = this.reloj.ahora();
    const { advertencias } = validarCertificadoParaUso(leido.info, {
      ambiente,
      rucEmisor: snapshot.emisor.ruc,
      ahora,
      forzar: opciones.forzar,
    });

    const huella = leido.info.huellaSha256;
    const pfxCifrado = this.cifrado.cifrar(pfx, CertificadoFiscalService.contextoPfx(ambiente, huella));
    const claveCifrada = this.cifrado.cifrarTexto(clave, CertificadoFiscalService.contextoClave(ambiente, huella));
    const nombreArchivo = (opciones.nombreArchivo ?? '').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || null;

    const { id_certificado, reemplazado } = await this.transacciones.ejecutar(async (tx) => {
      const resultado = await this.repositorio.reemplazarActivo(
        {
          ambiente,
          pfxCifrado,
          claveCifrada,
          nombreArchivo,
          titular: leido.info.titular,
          ruc: leido.info.ruc,
          numeroSerie: leido.info.numeroSerie,
          emisor: leido.info.emisor,
          vigenteDesde: leido.info.vigenteDesde,
          vigenteHasta: leido.info.vigenteHasta,
          huellaSha256: huella,
          bitsClave: leido.info.bitsClave,
          autofirmado: leido.info.autofirmado,
          certificadoPem: leido.certificatePem,
          subidoPor: actor.id_usuario,
        },
        tx,
      );
      await this.auditoria.registrar(
        {
          accion:
            opciones.accion === 'autofirmado'
              ? ACCIONES_AUDITORIA_FISCAL.CERT_AUTOFIRMADO_GENERADO
              : resultado.reemplazado
                ? ACCIONES_AUDITORIA_FISCAL.CERT_REEMPLAZADO
                : ACCIONES_AUDITORIA_FISCAL.CERT_SUBIDO,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_certificados',
          id_entidad: resultado.id_certificado,
          detalle: {
            ambiente,
            usuario: actor.nombre,
            titular: leido.info.titular,
            ruc: leido.info.ruc,
            numero_serie: leido.info.numeroSerie,
            emisor: leido.info.emisor,
            vigente_desde: leido.info.vigenteDesde,
            vigente_hasta: leido.info.vigenteHasta,
            huella_sha256: huella,
            bits: leido.info.bitsClave,
            autofirmado: leido.info.autofirmado,
            nombre_archivo: nombreArchivo,
            reemplaza_a: resultado.reemplazado,
            forzado: opciones.forzar,
          },
          ip: actor.ip,
        },
        tx,
      );
      return resultado;
    });
    this.trasCambio();

    const meta: MetadatosCertificadoFiscal = {
      id_certificado,
      ambiente,
      nombre_archivo: nombreArchivo,
      titular: leido.info.titular,
      ruc: leido.info.ruc,
      numero_serie: leido.info.numeroSerie,
      emisor: leido.info.emisor,
      vigente_desde: leido.info.vigenteDesde,
      vigente_hasta: leido.info.vigenteHasta,
      huella_sha256: huella,
      bits_clave: leido.info.bitsClave,
      autofirmado: leido.info.autofirmado,
      certificado_pem: leido.certificatePem,
      subido_por: actor.id_usuario,
      subido_en: ahora,
    };
    const info = describirCertificado(meta, { ahora, rucEmisor: snapshot.emisor.ruc });
    const avisos = Array.from(new Set([...advertencias, ...info.advertencias]));
    return { ...info, advertencias: avisos, reemplaza_a: reemplazado };
  }

  private trasCambio(): void {
    this.invalidar();
    this.notificador.notificar('certificado');
  }

  /** Material del certificado vigente de ESE ambiente (sin fallback), coherente entre instancias. */
  private async materialVigente(ambiente: AmbienteFiscal): Promise<MaterialCargado | null> {
    await this.esquema.exigir('secretos');
    const version = await this.cacheVersion.obtener(ambiente, () => this.repositorio.versionActiva(ambiente));
    if (!version) {
      this.cacheMaterial.invalidar(ambiente);
      return null;
    }
    let cargado = await this.cacheMaterial.obtener(ambiente, () => this.cargarMaterial(ambiente));
    if (!cargado || cargado.idCertificado !== version.id_certificado || cargado.huella !== version.huella_sha256) {
      // Otra instancia lo cambió: se vuelve a cargar una sola vez.
      this.cacheMaterial.invalidar(ambiente);
      cargado = await this.cacheMaterial.obtener(ambiente, () => this.cargarMaterial(ambiente));
    }
    return cargado;
  }

  private async esLegible(ambiente: AmbienteFiscal): Promise<boolean> {
    if (!this.cifrado.disponible()) return false;
    try {
      return !!(await this.materialVigente(ambiente));
    } catch {
      return false;
    }
  }

  private async cargarMaterial(ambiente: AmbienteFiscal): Promise<MaterialCargado | null> {
    const fila = await this.repositorio.activo(ambiente);
    if (!fila?.pfx_cifrado?.length) return null;

    const pfx = this.cifrado.descifrarDetallado(fila.pfx_cifrado, CertificadoFiscalService.contextoPfx(fila.ambiente, fila.huella_sha256));
    const clave = this.cifrado.descifrarDetallado(
      fila.clave_cifrada,
      CertificadoFiscalService.contextoClave(fila.ambiente, fila.huella_sha256),
    );
    try {
      const claveTexto = clave.plano.toString('utf8');
      let leido: CertificadoLeido;
      try {
        leido = leerPkcs12(pfx.plano, claveTexto);
      } catch (error: any) {
        this.logger.warn(`El certificado guardado de ${ambiente} no se pudo abrir: ${error?.message ?? error}`);
        throw new FiscalConfigError(
          'FISCAL_SECRETO_ILEGIBLE',
          'El certificado guardado no se pudo abrir. Vuelva a subir el .pfx con su contraseña.',
        );
      }
      if (leido.info.huellaSha256 !== fila.huella_sha256) {
        throw new FiscalConfigError('FISCAL_SECRETO_ILEGIBLE', 'El certificado guardado no coincide con su huella. Vuelva a subirlo.');
      }
      if (pfx.conLlaveAnterior || clave.conLlaveAnterior) this.recifrar(fila, pfx.plano, claveTexto);

      return {
        idCertificado: fila.id_certificado,
        huella: fila.huella_sha256,
        material: {
          privateKeyPem: leido.privateKeyPem,
          certificatePem: leido.certificatePem,
          huellaSha256: fila.huella_sha256,
          ruc: leido.info.ruc,
          vigenteHasta: leido.info.vigenteHasta,
          autofirmado: leido.info.autofirmado,
        },
      };
    } finally {
      pfx.plano.fill(0);
      clave.plano.fill(0);
    }
  }

  /** Rotación de FISCAL_SECRET_KEY: se cifra de nuevo con la llave actual (en segundo plano). */
  private recifrar(fila: FilaCertificadoFiscal, pfxPlano: Buffer, clave: string): void {
    const pfxCifrado = this.cifrado.cifrar(pfxPlano, CertificadoFiscalService.contextoPfx(fila.ambiente, fila.huella_sha256));
    const claveCifrada = this.cifrado.cifrarTexto(clave, CertificadoFiscalService.contextoClave(fila.ambiente, fila.huella_sha256));
    void this.repositorio
      .actualizarCifrado(fila.id_certificado, pfxCifrado, claveCifrada)
      .then(() =>
        this.auditoria.registrar({
          accion: ACCIONES_AUDITORIA_FISCAL.CERT_RECIFRADO,
          entidad: 'fiscal_certificados',
          id_entidad: fila.id_certificado,
          detalle: { ambiente: fila.ambiente, motivo: 'rotación de FISCAL_SECRET_KEY' },
        }),
      )
      .then(() => this.logger.log(`Certificado de ${fila.ambiente} re-cifrado con la FISCAL_SECRET_KEY actual.`))
      .catch((error: any) => this.logger.warn(`No se pudo re-cifrar el certificado: ${error?.message ?? error}`));
  }
}
