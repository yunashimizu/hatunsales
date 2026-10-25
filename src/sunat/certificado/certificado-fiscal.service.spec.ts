import { sign, verify, X509Certificate } from 'crypto';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { snapshotPrueba, VALORES_COMPLETOS } from '../config/configuracion.prueba-spec';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { AmbienteFiscal, SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { RelojFiscal } from '../config/reloj-fiscal';
import { EjecutorSql, TransaccionesFiscales } from '../config/transacciones-fiscales';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import {
  FilaCertificadoFiscal,
  MetadatosCertificadoFiscal,
  NuevoCertificadoFiscal,
  RepositorioCertificadosFiscales,
  VersionCertificadoFiscal,
} from './certificado-fiscal.repository';
import { CertificadoFiscalService, TAMANO_MAXIMO_CERTIFICADO } from './certificado-fiscal.service';
import { LLAVE_PRUEBA, OTRA_LLAVE_PRUEBA, OTRO_RUC, pfxAutofirmado, pfxConCadena, RUC_PRUEBA } from './certificados.prueba-spec';

type FilaMemoria = FilaCertificadoFiscal & { activo: boolean };

class RepositorioCertificadosMemoria extends RepositorioCertificadosFiscales {
  filas: FilaMemoria[] = [];
  lecturasCompletas = 0;
  recifrados: number[] = [];
  private siguiente = 1;

  async activo(ambiente: AmbienteFiscal): Promise<FilaCertificadoFiscal | null> {
    this.lecturasCompletas += 1;
    const fila = this.filas.find((f) => f.ambiente === ambiente && f.activo);
    return fila ? { ...fila } : null;
  }

  async metadatosActivos(): Promise<MetadatosCertificadoFiscal[]> {
    return this.filas.filter((f) => f.activo).map(({ pfx_cifrado, clave_cifrada, activo, ...meta }) => meta);
  }

  async versionActiva(ambiente: AmbienteFiscal): Promise<VersionCertificadoFiscal | null> {
    const fila = this.filas.find((f) => f.ambiente === ambiente && f.activo);
    return fila ? { id_certificado: fila.id_certificado, huella_sha256: fila.huella_sha256 } : null;
  }

  async reemplazarActivo(nuevo: NuevoCertificadoFiscal, ejecutor: EjecutorSql) {
    const reemplazado = await this.retirarActivo(nuevo.ambiente, nuevo.subidoPor, ejecutor);
    const id = this.siguiente++;
    this.filas.push({
      id_certificado: id,
      ambiente: nuevo.ambiente,
      nombre_archivo: nuevo.nombreArchivo,
      titular: nuevo.titular,
      ruc: nuevo.ruc,
      numero_serie: nuevo.numeroSerie,
      emisor: nuevo.emisor,
      vigente_desde: nuevo.vigenteDesde,
      vigente_hasta: nuevo.vigenteHasta,
      huella_sha256: nuevo.huellaSha256,
      bits_clave: nuevo.bitsClave,
      autofirmado: nuevo.autofirmado,
      certificado_pem: nuevo.certificadoPem,
      subido_por: nuevo.subidoPor,
      subido_en: new Date(),
      pfx_cifrado: nuevo.pfxCifrado,
      clave_cifrada: nuevo.claveCifrada,
      activo: true,
    });
    return { id_certificado: id, reemplazado };
  }

  async retirarActivo(ambiente: AmbienteFiscal, _idUsuario: number | null, ejecutor: EjecutorSql) {
    await ejecutor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fiscal:certificado:${ambiente}`]);
    const fila = this.filas.find((f) => f.ambiente === ambiente && f.activo);
    if (!fila) return null;
    fila.activo = false;
    fila.pfx_cifrado = Buffer.alloc(0);
    fila.clave_cifrada = Buffer.alloc(0);
    return fila.id_certificado;
  }

  async actualizarCifrado(idCertificado: number, pfxCifrado: Buffer, claveCifrada: Buffer): Promise<void> {
    const fila = this.filas.find((f) => f.id_certificado === idCertificado);
    if (fila) Object.assign(fila, { pfx_cifrado: pfxCifrado, clave_cifrada: claveCifrada });
    this.recifrados.push(idCertificado);
  }
}

class RelojManual extends RelojFiscal {
  t = Date.now();
  ahora(): Date {
    return new Date(this.t);
  }
}

function crear(
  opciones: {
    llave?: { actual?: string; anterior?: string };
    repo?: RepositorioCertificadosMemoria;
    snapshot?: SnapshotConfigFiscal;
    /** Claves de configuraciones (interruptor de emisión, confirmación del RUC…). */
    configuraciones?: Record<string, string>;
  } = {},
) {
  const repo = opciones.repo ?? new RepositorioCertificadosMemoria();
  let snapshot = opciones.snapshot ?? snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_ambiente: 'beta' });
  const config = {
    snapshot: async () => snapshot,
    snapshotFresco: async () => snapshot,
  } as unknown as FiscalConfigService;
  const esquema = { tiene: async () => true, exigir: async () => undefined } as unknown as FiscalEsquemaService;
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const consultas: string[] = [];
  const transacciones: TransaccionesFiscales = {
    ejecutar: async (trabajo) => trabajo({ query: async (sql: string, p?: unknown[]) => (consultas.push(`${sql} ${JSON.stringify(p ?? [])}`), []) }),
  };
  const reloj = new RelojManual();
  const notificador = new NotificadorCambiosFiscales();
  const valoresConfig: Record<string, string> = { ...(opciones.configuraciones ?? {}) };
  const configuraciones = {
    leer: async (claves: readonly string[]) => Object.fromEntries(claves.map((c) => [c, valoresConfig[c] || null])),
    guardar: async (pares: Record<string, string>) => {
      Object.assign(valoresConfig, pares);
    },
  } as unknown as RepositorioConfigFiscal;
  const interruptor = new InterruptorEmisionFiscal(
    configuraciones,
    transacciones,
    auditoria as unknown as FiscalAuditoriaRepository,
    notificador,
    config,
    reloj,
  );
  const servicio = new CertificadoFiscalService(
    repo,
    new CifradoFiscalService(opciones.llave ?? { actual: LLAVE_PRUEBA }),
    config,
    esquema,
    auditoria as unknown as FiscalAuditoriaRepository,
    transacciones,
    reloj,
    notificador,
    { obtener: jest.fn() } as unknown as CredencialesSolService,
    { obtener: jest.fn() } as unknown as CredencialesGreService,
    configuraciones,
    interruptor,
  );
  return {
    servicio,
    repo,
    auditoria,
    consultas,
    reloj,
    notificador,
    valoresConfig,
    cambiarSnapshot: (s: SnapshotConfigFiscal) => (snapshot = s),
  };
}

const ACTOR = { id_usuario: 1, nombre: 'Admin', ip: '127.0.0.1' };

async function codigoDe(promesa: Promise<unknown>): Promise<string | null> {
  try {
    await promesa;
    return null;
  } catch (error) {
    return error instanceof FiscalConfigError ? error.codigo : `otro: ${(error as Error).message}`;
  }
}

describe('CertificadoFiscalService', () => {
  const CLAVE = 'CdtSunat#2026';

  it('sube el CDT: lo guarda CIFRADO (pfx y contraseña), audita sin secretos y elige producción por omisión', async () => {
    const { servicio, repo, auditoria } = crear();
    const { contenido } = pfxConCadena(CLAVE);
    const info = await servicio.subir({ buffer: contenido, originalname: 'cdt.pfx', size: contenido.length }, CLAVE, {}, ACTOR);

    expect(info).toMatchObject({ ambiente: 'produccion', ruc: RUC_PRUEBA, autofirmado: false, bits_clave: 2048, reemplaza_a: null });
    expect(info.dias_para_vencer).toBeGreaterThan(300);
    expect(info.nombre_archivo).toBe('cdt.pfx');

    const fila = repo.filas[0];
    expect(fila.pfx_cifrado.includes(contenido.subarray(0, 64))).toBe(false);
    const cifrado = new CifradoFiscalService({ actual: LLAVE_PRUEBA });
    expect(cifrado.descifrar(fila.pfx_cifrado, `cert:pfx:produccion:${fila.huella_sha256}`).equals(contenido)).toBe(true);
    expect(cifrado.descifrarTexto(fila.clave_cifrada, `cert:clave:produccion:${fila.huella_sha256}`)).toBe(CLAVE);

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    const [evento] = auditoria.registrar.mock.calls[0] as unknown as [{ accion: string; detalle: object }];
    expect(evento.accion).toBe('CERT_SUBIDO');
    expect(JSON.stringify(evento)).not.toContain(CLAVE);
  });

  it('entrega el MaterialFirma (firma de verdad), lo cachea y lo recarga si otra instancia cambió el certificado', async () => {
    const { servicio, repo, reloj } = crear();
    const primero = pfxConCadena(CLAVE);
    await servicio.subir({ buffer: primero.contenido, originalname: 'a.pfx' }, CLAVE, {}, ACTOR);

    const material = await servicio.obtenerMaterialFirma('produccion');
    const datos = Buffer.from('<Invoice/>');
    expect(verify('sha256', datos, new X509Certificate(material.certificatePem).publicKey, sign('sha256', datos, material.privateKeyPem))).toBe(true);
    expect(material).toMatchObject({ ruc: RUC_PRUEBA, autofirmado: false });

    await servicio.obtenerMaterialFirma('produccion');
    expect(repo.lecturasCompletas).toBe(1);

    // Otra instancia reemplaza el certificado directamente en la BD.
    const segundo = pfxConCadena(CLAVE);
    const otraInstancia = crear({ repo }).servicio;
    await otraInstancia.subir({ buffer: segundo.contenido, originalname: 'b.pfx' }, CLAVE, {}, ACTOR);

    // Dentro de los 30 s sigue el material en caché; después se detecta el cambio por id+huella.
    expect((await servicio.obtenerMaterialFirma('produccion')).huellaSha256).toBe(material.huellaSha256);
    reloj.t += 31_000;
    const nuevo = await servicio.obtenerMaterialFirma('produccion');
    expect(nuevo.huellaSha256).not.toBe(material.huellaSha256);
  });

  it('al reemplazar, el anterior queda como historial sin secretos', async () => {
    const { servicio, repo, auditoria } = crear();
    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'a.pfx' }, CLAVE, {}, ACTOR);
    const reemplazo = await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'b.pfx' }, CLAVE, {}, ACTOR);
    expect(reemplazo.reemplaza_a).toBe(1);
    expect(repo.filas[0]).toMatchObject({ activo: false });
    expect(repo.filas[0].pfx_cifrado.length).toBe(0);
    expect((auditoria.registrar.mock.calls[1] as unknown as [{ accion: string }])[0].accion).toBe('CERT_REEMPLAZADO');
  });

  it('en BETA usa el certificado de pruebas o, si no hay, el de producción', async () => {
    const { servicio } = crear();
    expect(await codigoDe(servicio.obtenerMaterialFirma('beta'))).toBe('FISCAL_CERT_NO_CARGADO');
    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'cdt.pfx' }, CLAVE, {}, ACTOR);
    const deProduccion = await servicio.obtenerMaterialFirma('beta');
    expect(deProduccion.autofirmado).toBe(false);

    const prueba = pfxAutofirmado({ clave: 'beta1234' });
    const info = await servicio.subir({ buffer: prueba, originalname: 'prueba.p12' }, 'beta1234', {}, ACTOR);
    expect(info.ambiente).toBe('beta');
    expect((await servicio.obtenerMaterialFirma('beta')).autofirmado).toBe(true);
  });

  it('valida el archivo por tamaño, extensión y contenido', async () => {
    const { servicio } = crear();
    expect(await codigoDe(servicio.subir(undefined, CLAVE, {}, ACTOR))).toBe('FISCAL_CERT_FORMATO_INVALIDO');
    const grande = Buffer.alloc(TAMANO_MAXIMO_CERTIFICADO + 1, 0x30);
    expect(await codigoDe(servicio.subir({ buffer: grande, originalname: 'x.pfx' }, CLAVE, {}, ACTOR))).toBe('FISCAL_CERT_DEMASIADO_GRANDE');
    const valido = pfxConCadena(CLAVE).contenido;
    expect(await codigoDe(servicio.subir({ buffer: valido, originalname: 'publico.cer' }, CLAVE, {}, ACTOR))).toBe('FISCAL_CERT_SIN_CLAVE_PRIVADA');
    expect(await codigoDe(servicio.subir({ buffer: valido, originalname: 'foto.jpg' }, CLAVE, {}, ACTOR))).toBe('FISCAL_CERT_FORMATO_INVALIDO');
    expect(await codigoDe(servicio.subir({ buffer: Buffer.from('no es un pfx'), originalname: 'x.pfx' }, CLAVE, {}, ACTOR))).toBe(
      'FISCAL_CERT_FORMATO_INVALIDO',
    );
    expect(await codigoDe(servicio.subir({ buffer: valido, originalname: 'x.pfx' }, 'otra', {}, ACTOR))).toBe('FISCAL_CERT_CLAVE_INCORRECTA');
  });

  it('rechaza un certificado de otro RUC (422) y un autofirmado para producción', async () => {
    const { servicio } = crear();
    const ajeno = pfxConCadena(CLAVE, OTRO_RUC).contenido;
    expect(await codigoDe(servicio.subir({ buffer: ajeno, originalname: 'x.pfx' }, CLAVE, {}, ACTOR))).toBe('FISCAL_CERT_RUC_NO_COINCIDE');
    const forzado = await servicio.subir({ buffer: ajeno, originalname: 'x.pfx' }, CLAVE, { ambiente: 'beta', forzar: true }, ACTOR);
    expect(forzado.advertencias.join(' ')).toMatch(OTRO_RUC);

    const autofirmado = pfxAutofirmado({ clave: 'auto1234' });
    expect(await codigoDe(servicio.subir({ buffer: autofirmado, originalname: 'x.pfx' }, 'auto1234', { ambiente: 'produccion' }, ACTOR))).toBe(
      'FISCAL_CERT_AUTOFIRMADO',
    );
  });

  it('no deja eliminar el certificado de producción en uso; si no está en uso lo retira y audita', async () => {
    const { servicio, auditoria, cambiarSnapshot, consultas } = crear();
    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'cdt.pfx' }, CLAVE, {}, ACTOR);
    await servicio.obtenerMaterialFirma('produccion');

    cambiarSnapshot(snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo' }));
    expect(await codigoDe(servicio.eliminar('produccion', ACTOR))).toBe('FISCAL_CERT_EN_USO');

    cambiarSnapshot(snapshotPrueba(VALORES_COMPLETOS));
    expect(await servicio.eliminar('produccion', ACTOR)).toEqual({ eliminado: true, ambiente: 'produccion', id_certificado: 1 });
    expect(consultas.some((c) => c.includes('fiscal:config'))).toBe(true);
    expect((auditoria.registrar.mock.calls.at(-1) as unknown as [{ accion: string }])[0].accion).toBe('CERT_ELIMINADO');
    expect(await codigoDe(servicio.obtenerMaterialFirma('produccion'))).toBe('FISCAL_CERT_NO_CARGADO');
    expect(await codigoDe(servicio.eliminar('produccion', ACTOR))).toBe('FISCAL_CERT_NO_CARGADO');
  });

  it('el autofirmado se genera solo con el ambiente BETA', async () => {
    const enProduccion = crear({ snapshot: snapshotPrueba(VALORES_COMPLETOS) }).servicio;
    expect(await codigoDe(enProduccion.generarAutofirmadoBeta(ACTOR))).toBe('FISCAL_SOLO_BETA');

    const { servicio, auditoria } = crear();
    const info = await servicio.generarAutofirmadoBeta(ACTOR, 90);
    expect(info).toMatchObject({ ambiente: 'beta', autofirmado: true, ruc: RUC_PRUEBA });
    expect(info.dias_para_vencer).toBeGreaterThanOrEqual(89);
    expect((auditoria.registrar.mock.calls[0] as unknown as [{ accion: string }])[0].accion).toBe('CERT_AUTOFIRMADO_GENERADO');
    expect((await servicio.obtenerMaterialFirma('beta')).autofirmado).toBe(true);
  });

  it('exporta la parte pública para SOL (.cer DER y Base64)', async () => {
    const { servicio } = crear();
    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'cdt.pfx' }, CLAVE, {}, ACTOR);
    const der = await servicio.exportarPublico('produccion', 'cer');
    expect(der).toMatchObject({ mime: 'application/pkix-cert', nombreArchivo: `certificado-${RUC_PRUEBA}-produccion.cer` });
    expect(() => new X509Certificate(der.contenido)).not.toThrow();
    const pem = await servicio.exportarPublico('produccion', 'pem');
    expect(pem.nombreArchivo).toBe(`certificado-${RUC_PRUEBA}-produccion-base64.cer`);
    expect(await codigoDe(servicio.exportarPublico('beta', 'cer'))).toBe('FISCAL_CERT_NO_CARGADO');
  });

  it('sin FISCAL_SECRET_KEY no guarda nada (503 FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA)', async () => {
    const { servicio, repo } = crear({ llave: { actual: undefined } });
    const codigo = await codigoDe(servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'x.pfx' }, CLAVE, {}, ACTOR));
    expect(codigo).toBe('FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA');
    expect(repo.filas).toHaveLength(0);
  });

  it('rotación de llave: abre con la anterior, lo re-cifra con la actual; con otra llave queda ilegible', async () => {
    const repo = new RepositorioCertificadosMemoria();
    await crear({ repo, llave: { actual: OTRA_LLAVE_PRUEBA } }).servicio.subir(
      { buffer: pfxConCadena(CLAVE).contenido, originalname: 'x.pfx' },
      CLAVE,
      {},
      ACTOR,
    );

    const sinAnterior = crear({ repo, llave: { actual: LLAVE_PRUEBA } }).servicio;
    expect(await codigoDe(sinAnterior.obtenerMaterialFirma('produccion'))).toBe('FISCAL_SECRETO_ILEGIBLE');
    expect((await sinAnterior.estadoParaChecklist()).produccion?.legible).toBe(false);

    const rotado = crear({ repo, llave: { actual: LLAVE_PRUEBA, anterior: OTRA_LLAVE_PRUEBA } }).servicio;
    expect((await rotado.obtenerMaterialFirma('produccion')).ruc).toBe(RUC_PRUEBA);
    await new Promise((r) => setImmediate(r));
    expect(repo.recifrados).toEqual([1]);
    const soloNueva = crear({ repo, llave: { actual: LLAVE_PRUEBA } }).servicio;
    expect((await soloNueva.estadoParaChecklist()).produccion?.legible).toBe(true);
  });

  it('un certificado nuevo reanuda la emisión detenida de SU ambiente y retira la confirmación del RUC del anterior', async () => {
    const bloqueo = JSON.stringify({ codigo: '2325', motivo: 'El certificado no está registrado en SOL.', fecha: '2026-10-20T10:00:00.000Z' });
    const { servicio, valoresConfig, auditoria, notificador } = crear({
      configuraciones: {
        fiscal_emision_bloqueada_produccion: bloqueo,
        fiscal_emision_bloqueada_beta: bloqueo,
        fiscal_cert_ruc_confirmado_produccion: 'true',
      },
    });
    const avisos: string[] = [];
    notificador.suscribir((tipo) => avisos.push(tipo));

    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'cdt.pfx' }, CLAVE, {}, ACTOR);

    expect(valoresConfig.fiscal_emision_bloqueada_produccion).toBe('');
    expect(valoresConfig.fiscal_cert_ruc_confirmado_produccion).toBe('');
    expect(valoresConfig.fiscal_emision_bloqueada_beta).toBe(bloqueo);
    const acciones = auditoria.registrar.mock.calls.map((c) => (c as unknown as [{ accion: string }])[0].accion);
    expect(acciones).toEqual(['CERT_SUBIDO', 'CERT_RUC_CONFIRMACION_RETIRADA', 'EMISION_REANUDADA']);
    expect(avisos).toEqual(expect.arrayContaining(['certificado', 'config']));
  });

  it('un certificado de BETA solo toca el interruptor de BETA (no la confirmación de producción)', async () => {
    const bloqueo = JSON.stringify({ codigo: '0102', motivo: 'x', fecha: '2026-10-20T10:00:00.000Z' });
    const { servicio, valoresConfig, auditoria } = crear({
      configuraciones: { fiscal_emision_bloqueada_beta: bloqueo, fiscal_cert_ruc_confirmado_produccion: 'true' },
    });
    await servicio.subir({ buffer: pfxAutofirmado({ clave: 'beta1234' }), originalname: 'prueba.p12' }, 'beta1234', {}, ACTOR);
    expect(valoresConfig.fiscal_emision_bloqueada_beta).toBe('');
    expect(valoresConfig.fiscal_cert_ruc_confirmado_produccion).toBe('true');
    expect(auditoria.registrar.mock.calls.map((c) => (c as unknown as [{ accion: string }])[0].accion)).toEqual([
      'CERT_SUBIDO',
      'EMISION_REANUDADA',
    ]);
  });

  it('nunca entrega un certificado vencido', async () => {
    const { servicio, reloj } = crear();
    await servicio.subir({ buffer: pfxConCadena(CLAVE).contenido, originalname: 'cdt.pfx' }, CLAVE, {}, ACTOR);
    reloj.t += 400 * 24 * 3600 * 1000;
    expect(await codigoDe(servicio.obtenerMaterialFirma('produccion'))).toBe('FISCAL_CERT_VENCIDO');
  });
});
