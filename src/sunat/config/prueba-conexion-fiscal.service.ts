import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { sign, verify, X509Certificate } from 'crypto';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { MaterialFirma } from '../certificado/material-firma';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService, enmascararIdentificador } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import type { DocumentoPrueba } from './fiscal-config.dto';
import { FiscalConfigService } from './fiscal-config.service';
import { ActorFiscal, AmbienteFiscal } from './fiscal-config.tipos';
import { FiscalEsquemaService } from './fiscal-esquema.service';
import {
  ContextoPruebaEnvio,
  EMISOR_PRUEBA_BETA,
  EmisorPruebaBeta,
  PasoPruebaFiscal,
  PROBADOR_ENVIO_CPE,
  PROBADOR_ENVIO_GRE,
  ProbadorEnvioFiscal,
} from './fiscal-tokens';
import { diasHasta, fechaEnLima, RelojFiscal } from './reloj-fiscal';

export interface ResultadoPruebaConexion {
  ok: boolean;
  ambiente: AmbienteFiscal;
  documento: DocumentoPrueba;
  tiempo_ms: number;
  /** false mientras el módulo de emisión/GRE no registre su probador de envío. */
  envio_disponible: boolean;
  pasos: PasoPruebaFiscal[];
}

function mensajeDe(error: unknown): { detalle: string; codigo?: string; envio_id?: number } {
  const e = error as { message?: string; codigo?: string; getResponse?: () => unknown };
  const cuerpo = e?.getResponse?.() as { id_envio?: number } | undefined;
  return { detalle: String(e?.message ?? error ?? 'Error desconocido').slice(0, 500), codigo: e?.codigo,
    ...(cuerpo?.id_envio ? { envio_id: cuerpo.id_envio } : {}) };
}

function fechaCorta(fecha: Date): string {
  const [anio, mes, dia] = fechaEnLima(fecha).split('-');
  return `${dia}/${mes}/${anio}`;
}

/**
 * «Probar conexión»: valida localmente todo lo que el dueño configuró
 * (esquema, llave, certificado, firma y credenciales) y, si el módulo de
 * emisión o de GRE registró su probador, delega el envío/autenticación real.
 * Nunca emite comprobantes reales: en producción la prueba de factura/boleta
 * se queda en los pasos locales (la consulta de credenciales es otra acción).
 */
@Injectable()
export class PruebaConexionFiscalService {
  private readonly logger = new Logger(PruebaConexionFiscalService.name);

  constructor(
    private readonly config: FiscalConfigService,
    private readonly esquema: FiscalEsquemaService,
    private readonly cifrado: CifradoFiscalService,
    private readonly certificados: CertificadoFiscalService,
    private readonly credencialesSol: CredencialesSolService,
    private readonly credencialesGre: CredencialesGreService,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly reloj: RelojFiscal,
    private readonly moduleRef: ModuleRef,
  ) {}

  async probar(
    opciones: { ambiente?: AmbienteFiscal; documento?: DocumentoPrueba; tipoCpe?: '01' | '03' },
    actor: ActorFiscal,
  ): Promise<ResultadoPruebaConexion> {
    const inicio = this.reloj.ms();
    const snapshot = await this.config.snapshot();
    const ambiente = opciones.ambiente ?? snapshot.ambiente;
    const documento = opciones.documento ?? 'cpe';
    const pasos: PasoPruebaFiscal[] = [];

    const contexto = await this.pasosLocales(ambiente, documento, actor, pasos);
    if (contexto) contexto.tipoCpe = opciones.tipoCpe;
    const probador = this.probador(documento);
    if (contexto && ambiente === 'produccion' && documento === 'cpe') {
      // En producción todo comprobante enviado es real: aquí solo se comprueba lo local.
      pasos.push({
        paso: 'envio',
        ok: null,
        detalle:
          'En producción no se envían comprobantes de prueba. Use «Probar credenciales SOL de producción» '
          + '(una consulta a SUNAT que no emite nada) para verificar el usuario secundario.',
      });
    } else if (contexto) {
      if (probador) {
        try {
          pasos.push(...(await probador.probar(contexto)));
        } catch (error) {
          pasos.push({ paso: 'envio', ok: false, ...mensajeDe(error) });
        }
      } else {
        pasos.push({
          paso: 'envio',
          ok: null,
          detalle:
            documento === 'gre'
              ? 'La prueba contra la API de GRE de SUNAT se habilita con el módulo de guía de remisión. Lo configurado localmente está correcto.'
              : 'El envío de prueba a SUNAT se habilita con el módulo de emisión. Lo configurado localmente está correcto.',
        });
      }
    }

    const ejecutados = pasos.filter((p) => p.ok !== null);
    const resultado: ResultadoPruebaConexion = {
      ok: ejecutados.length > 0 && ejecutados.every((p) => p.ok === true),
      ambiente,
      documento,
      tiempo_ms: this.reloj.ms() - inicio,
      envio_disponible: !!probador,
      pasos,
    };
    await this.auditar(resultado, actor);
    return resultado;
  }

  private async pasosLocales(
    ambiente: AmbienteFiscal,
    documento: DocumentoPrueba,
    actor: ActorFiscal,
    pasos: PasoPruebaFiscal[],
  ): Promise<ContextoPruebaEnvio | null> {
    const ejecutar = async <T>(paso: string, trabajo: () => Promise<{ valor: T; detalle: string }>): Promise<T | null> => {
      const inicio = this.reloj.ms();
      try {
        const { valor, detalle } = await trabajo();
        pasos.push({ paso, ok: true, detalle, tiempo_ms: this.reloj.ms() - inicio });
        return valor;
      } catch (error) {
        pasos.push({ paso, ok: false, ...mensajeDe(error), tiempo_ms: this.reloj.ms() - inicio });
        return null;
      }
    };

    const esquemaOk = await ejecutar('esquema', async () => {
      await this.esquema.exigir('secretos');
      return { valor: true, detalle: 'Base de datos preparada (sql/fase9_sunat_directo.sql).' };
    });
    if (!esquemaOk) return null;

    const cifradoOk = await ejecutar('cifrado', async () => {
      this.cifrado.exigirDisponible();
      return { valor: true, detalle: 'FISCAL_SECRET_KEY configurada.' };
    });
    if (!cifradoOk) return null;

    const material = await ejecutar<MaterialFirma>('certificado', async () => {
      const valor = await this.certificados.obtenerMaterialFirma(ambiente);
      const dias = diasHasta(valor.vigenteHasta, this.reloj.ahora());
      const tipo = valor.autofirmado ? 'Certificado autofirmado de prueba' : 'Certificado digital';
      return {
        valor,
        detalle: `${tipo}${valor.ruc ? ` del RUC ${valor.ruc}` : ''}, vence el ${fechaCorta(valor.vigenteHasta)} (${dias} días).`,
      };
    });
    if (!material) return null;

    const firmaOk = await ejecutar('firma', async () => {
      const datos = Buffer.from(`hatunsales:prueba-firma:${this.reloj.ms()}`, 'utf8');
      const firma = sign('sha256', datos, material.privateKeyPem);
      if (!verify('sha256', datos, new X509Certificate(material.certificatePem).publicKey, firma)) {
        throw new Error('La firma no se pudo verificar con el certificado: la clave privada no corresponde.');
      }
      return { valor: true, detalle: 'Firma RSA-SHA256 hecha y verificada localmente con el certificado.' };
    });
    if (!firmaOk) return null;

    const emisor = ambiente === 'beta' && documento === 'cpe' ? await this.emisorBeta() : await this.config.emisor();
    if (documento === 'gre') {
      const credencialesGre = await ejecutar('credenciales', async () => {
        const valor = await this.credencialesGre.obtener(ambiente);
        return {
          valor,
          detalle: `Credenciales API (client_id ${enmascararIdentificador(valor.clientId)}) y usuario SOL ${valor.usuarioSol}.`,
        };
      });
      return credencialesGre
        ? { ambiente, documento, material, emisor, credencialesGre, idUsuario: actor.id_usuario }
        : null;
    }

    const credencialesSol = await ejecutar('credenciales', async () => {
      const valor = ambiente === 'beta'
        ? { usuario: `${emisor.ruc}${CredencialesSolService.SUFIJO_BETA}`, clave: CredencialesSolService.CLAVE_BETA }
        : await this.credencialesSol.obtener(ambiente);
      return {
        valor,
        detalle:
          ambiente === 'beta'
            ? `Usuario BETA de SUNAT ${valor.usuario} (público).`
            : `Usuario secundario SOL ${valor.usuario} con clave registrada.`,
      };
    });
    return credencialesSol ? { ambiente, documento, material, emisor, credencialesSol, idUsuario: actor.id_usuario } : null;
  }

  private probador(documento: DocumentoPrueba): ProbadorEnvioFiscal | null {
    try {
      return this.moduleRef.get<ProbadorEnvioFiscal>(documento === 'gre' ? PROBADOR_ENVIO_GRE : PROBADOR_ENVIO_CPE, {
        strict: false,
      });
    } catch {
      return null; // todavía no registrado
    }
  }

  private async emisorBeta() {
    let proveedor: EmisorPruebaBeta | null = null;
    try { proveedor = this.moduleRef.get<EmisorPruebaBeta>(EMISOR_PRUEBA_BETA, { strict: false }); }
    catch { /* El módulo de configuración funciona también sin emisión instalada. */ }
    return proveedor ? proveedor.obtenerEmisor() : this.config.emisor();
  }

  private async auditar(resultado: ResultadoPruebaConexion, actor: ActorFiscal): Promise<void> {
    try {
      await this.auditoria.registrar({
        accion: ACCIONES_AUDITORIA_FISCAL.PRUEBA_CONEXION,
        id_usuario: actor.id_usuario,
        entidad: 'fiscal',
        id_entidad: resultado.documento,
        detalle: {
          usuario: actor.nombre,
          ambiente: resultado.ambiente,
          documento: resultado.documento,
          ok: resultado.ok,
          pasos: resultado.pasos.map((p) => ({ paso: p.paso, ok: p.ok, codigo: p.codigo ?? null })),
        },
        ip: actor.ip,
      });
    } catch (error: any) {
      this.logger.warn(`No se pudo auditar la prueba de conexión: ${error?.message ?? error}`);
    }
  }
}
