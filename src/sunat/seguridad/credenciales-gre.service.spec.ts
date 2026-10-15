import { LLAVE_PRUEBA, OTRA_LLAVE_PRUEBA } from '../certificado/certificados.prueba-spec';
import { snapshotPrueba, VALORES_COMPLETOS } from '../config/configuracion.prueba-spec';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { RelojSistemaFiscal } from '../config/reloj-fiscal';
import { EjecutorSql } from '../config/transacciones-fiscales';
import { BovedaSecretosFiscales } from './boveda-secretos.service';
import { CifradoFiscalService } from './cifrado-fiscal.service';
import {
  combinarDiagnosticos,
  CredencialesGreService,
  enmascararIdentificador,
  validarClientIdGre,
  validarClientSecretGre,
} from './credenciales-gre.service';
import { CredencialesSolService } from './credenciales-sol.service';
import { RepositorioSecretosFiscales, SecretoFiscalGuardado } from './secretos-fiscales.repository';

class SecretosMemoria extends RepositorioSecretosFiscales {
  readonly filas = new Map<string, SecretoFiscalGuardado>();
  async leer(clave: string) {
    return this.filas.get(clave) ?? null;
  }
  async metadatos(clave: string) {
    const fila = this.filas.get(clave);
    return fila?.valor_cifrado.length ? { actualizado_en: fila.actualizado_en, actualizado_por: fila.actualizado_por } : null;
  }
  async guardar(clave: string, valorCifrado: Buffer, idUsuario: number | null) {
    this.filas.set(clave, { valor_cifrado: valorCifrado, actualizado_en: new Date(), actualizado_por: idUsuario });
  }
  async eliminar(clave: string) {
    return this.filas.delete(clave);
  }
}

const TX: EjecutorSql = { query: async () => [] };
const CLIENT_ID = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const CLIENT_SECRET = 'Hty/M6QshYvPgItX2P0+Kw==';

function crear(opciones: { llave?: string; repo?: SecretosMemoria; esquemaListo?: boolean; valores?: Record<string, string> } = {}) {
  const repo = opciones.repo ?? new SecretosMemoria();
  const esquemaListo = opciones.esquemaListo ?? true;
  const esquema = {
    tiene: async () => esquemaListo,
    exigir: async () => {
      if (!esquemaListo) throw new FiscalConfigError('FISCAL_MIGRACION_PENDIENTE', 'Falta ejecutar sql/fase9_sunat_directo.sql');
    },
  } as unknown as FiscalEsquemaService;
  const notificador = new NotificadorCambiosFiscales();
  const boveda = new BovedaSecretosFiscales(
    repo,
    new CifradoFiscalService({ actual: opciones.llave ?? LLAVE_PRUEBA }),
    esquema,
    new RelojSistemaFiscal(),
    notificador,
  );
  const snapshot = snapshotPrueba(opciones.valores ?? VALORES_COMPLETOS);
  const config = { snapshot: async () => snapshot } as unknown as FiscalConfigService;
  const sol = new CredencialesSolService(boveda, config);
  return { repo, boveda, sol, gre: new CredencialesGreService(boveda, sol), notificador };
}

async function codigoDe(promesa: Promise<unknown>): Promise<string | null> {
  try {
    await promesa;
    return null;
  } catch (error) {
    return error instanceof FiscalConfigError ? error.codigo : `otro: ${(error as Error).message}`;
  }
}

describe('Credenciales API de la GRE y clave SOL (bóveda cifrada)', () => {
  it('guarda client_id y client_secret cifrados y solo informa tiene_credenciales y una máscara', async () => {
    const { gre, repo } = crear();
    expect(await gre.estado()).toEqual({ tiene_credenciales: false, client_id_mascara: null, actualizado_en: null });

    expect(await gre.guardar(CLIENT_ID, CLIENT_SECRET, 1, TX)).toBe('1a2b…5c6d');
    for (const fila of repo.filas.values()) {
      expect(fila.valor_cifrado.toString('utf8')).not.toContain(CLIENT_SECRET);
      expect(fila.valor_cifrado.toString('utf8')).not.toContain(CLIENT_ID);
    }
    const estado = await gre.estado();
    expect(estado).toMatchObject({ tiene_credenciales: true, client_id_mascara: '1a2b…5c6d' });
    expect(JSON.stringify(estado)).not.toContain(CLIENT_SECRET);
    expect(await gre.diagnostico()).toBe('ok');
  });

  it('entrega al módulo GRE las credenciales API + usuario/clave SOL del ambiente', async () => {
    const { gre, sol } = crear();
    await gre.guardar(CLIENT_ID, CLIENT_SECRET, 1, TX);
    expect(await gre.obtener('beta')).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      usuarioSol: '20610206337MODDATOS',
      claveSol: 'MODDATOS',
    });

    expect(await codigoDe(gre.obtener('produccion'))).toBe('FISCAL_CREDENCIALES_SOL_FALTAN');
    await sol.guardarClave('ClaveSol#1', 1, TX);
    expect(await gre.obtener('produccion')).toMatchObject({ usuarioSol: '20610206337HATUN001', claveSol: 'ClaveSol#1' });
  });

  it('sin credenciales API responde FISCAL_CREDENCIALES_GRE_FALTAN (503)', async () => {
    const { gre } = crear();
    const codigo = await codigoDe(gre.obtener('produccion'));
    expect(codigo).toBe('FISCAL_CREDENCIALES_GRE_FALTAN');
    expect(new FiscalConfigError('FISCAL_CREDENCIALES_GRE_FALTAN', 'x').estadoHttp).toBe(503);
  });

  it('diagnostica falta, ilegible (otra llave) y sin_esquema sin exponer valores', async () => {
    const repo = new SecretosMemoria();
    const original = crear({ repo });
    expect(await original.gre.diagnostico()).toBe('falta');
    await original.gre.guardar(CLIENT_ID, CLIENT_SECRET, 1, TX);

    const otraLlave = crear({ repo, llave: OTRA_LLAVE_PRUEBA });
    expect(await otraLlave.gre.diagnostico()).toBe('ilegible');
    expect((await otraLlave.gre.estado()).client_id_mascara).toBeNull();
    expect(await crear({ repo, esquemaListo: false }).gre.diagnostico()).toBe('sin_esquema');
  });

  it('eliminar borra ambos secretos', async () => {
    const { gre, repo } = crear();
    await gre.guardar(CLIENT_ID, CLIENT_SECRET, 1, TX);
    expect(await gre.eliminar(TX)).toBe(true);
    expect(repo.filas.size).toBe(0);
    expect((await gre.estado()).tiene_credenciales).toBe(false);
  });

  it('la caché se invalida al guardar y con el aviso de credenciales', async () => {
    const { sol, boveda, notificador, repo } = crear();
    await sol.guardarClave('Primera#01', 1, TX);
    expect((await sol.obtener('produccion')).clave).toBe('Primera#01');

    // Otra instancia cambia la clave en la BD; aquí se ve al recibir el aviso.
    const otra = crear({ repo });
    await otra.sol.guardarClave('Segunda#02', 1, TX);
    expect((await sol.obtener('produccion')).clave).toBe('Primera#01');
    notificador.notificar('credenciales');
    expect((await sol.obtener('produccion')).clave).toBe('Segunda#02');
    expect(boveda).toBeDefined();
  });

  it('valida el formato de las credenciales y combina diagnósticos', () => {
    expect(validarClientIdGre(` ${CLIENT_ID} `)).toBe(CLIENT_ID);
    expect(() => validarClientIdGre('con espacio')).toThrow(FiscalConfigError);
    expect(() => validarClientSecretGre('corto')).toThrow(/entre 8 y 200/);
    expect(() => validarClientSecretGre('tiene espacio')).toThrow(FiscalConfigError);
    expect(enmascararIdentificador('abcdefghijkl')).toBe('abcd…ijkl');
    expect(enmascararIdentificador(null)).toBeNull();
    expect(combinarDiagnosticos('ok', 'ok')).toBe('ok');
    expect(combinarDiagnosticos('ok', 'ilegible')).toBe('ilegible');
    expect(combinarDiagnosticos('sin_cifrado', 'falta')).toBe('falta');
    expect(combinarDiagnosticos('falta', 'sin_esquema')).toBe('sin_esquema');
  });

  it('credenciales SOL: BETA usa RUC+MODDATOS; producción exige usuario y clave', async () => {
    const sinUsuario = crear({ valores: { ...VALORES_COMPLETOS, fiscal_sol_usuario: '' } }).sol;
    expect(await sinUsuario.obtener('beta')).toEqual({ usuario: '20610206337MODDATOS', clave: 'MODDATOS' });
    expect(await codigoDe(sinUsuario.obtener('produccion'))).toBe('FISCAL_CREDENCIALES_SOL_FALTAN');
    expect((await sinUsuario.estado()).tiene_clave).toBe(false);
  });
});
