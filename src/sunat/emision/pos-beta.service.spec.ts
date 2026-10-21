import { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { EmisorBetaService } from './emisor-beta.service';
import { PosBetaService, CLAVE_POS_BETA_ACTIVO } from './pos-beta.service';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';

describe('PosBetaService', () => {
  const ruc = '20614736420';
  let repo: {
    leer: jest.Mock;
    guardar: jest.Mock;
  };
  let fiscal: {
    ambiente: jest.Mock;
    siguienteCorrelativoBeta: jest.Mock;
  };
  let esquema: {
    exigir: jest.Mock;
    tiene: jest.Mock;
  };
  let emisor: { obtenerEmisor: jest.Mock };
  let certificados: {
    infoActivo: jest.Mock;
    obtenerMaterialFirmaBeta: jest.Mock;
  };
  let auditoria: { registrar: jest.Mock };
  let transacciones: { ejecutar: jest.Mock };
  let servicio: PosBetaService;

  beforeEach(() => {
    repo = {
      leer: jest.fn().mockResolvedValue({ [CLAVE_POS_BETA_ACTIVO]: 'true' }),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    fiscal = {
      ambiente: jest.fn().mockResolvedValue('beta'),
      siguienteCorrelativoBeta: jest.fn().mockResolvedValue(8),
    };
    esquema = {
      exigir: jest.fn().mockResolvedValue(undefined),
      tiene: jest.fn().mockResolvedValue(true),
    };
    emisor = {
      obtenerEmisor: jest.fn().mockResolvedValue({ ruc }),
    };
    certificados = {
      infoActivo: jest.fn().mockResolvedValue({ ruc, vencido: false }),
      obtenerMaterialFirmaBeta: jest.fn().mockResolvedValue({ ruc }),
    };
    auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
    transacciones = {
      ejecutar: jest.fn(async (trabajo: (tx: { query: jest.Mock }) => Promise<unknown>) =>
        trabajo({ query: jest.fn() }),
      ),
    };
    servicio = new PosBetaService(
      repo as unknown as RepositorioConfigFiscal,
      fiscal as unknown as FiscalConfigService,
      esquema as unknown as FiscalEsquemaService,
      emisor as unknown as EmisorBetaService,
      certificados as unknown as CertificadoFiscalService,
      {} as SunatEmisionBetaService,
      auditoria as unknown as FiscalAuditoriaRepository,
      transacciones as unknown as TransaccionesFiscales,
    );
  });

  it('solo considera activa la opción explícita cuando el ambiente sigue siendo BETA', async () => {
    expect(await servicio.activoEnBeta()).toBe(true);
    fiscal.ambiente.mockResolvedValueOnce('produccion');
    expect(await servicio.activoEnBeta()).toBe(false);
  });

  it('previsualiza el siguiente correlativo sin incrementarlo', async () => {
    repo.leer.mockResolvedValueOnce({ fiscal_beta_correlativo: '41' });
    expect(await servicio.siguienteCorrelativoVista()).toBe(42);
    expect(fiscal.siguienteCorrelativoBeta).not.toHaveBeenCalled();
  });

  it('exige que el certificado BETA corresponda al emisor antes de activar el POS', async () => {
    certificados.obtenerMaterialFirmaBeta.mockResolvedValueOnce({ ruc: '20131312955' });
    await expect(
      servicio.cambiarEstado(true, { id_usuario: 7, nombre: 'admin', ip: '127.0.0.1' }),
    ).rejects.toBeInstanceOf(FiscalConfigError);
    expect(repo.guardar).not.toHaveBeenCalled();
    expect(transacciones.ejecutar).not.toHaveBeenCalled();
  });

  it('activa y audita solo después de verificar BETA, esquema y RUC del certificado', async () => {
    const resultado = await servicio.cambiarEstado(true, {
      id_usuario: 7,
      nombre: 'admin',
      ip: '127.0.0.1',
    });
    expect(esquema.exigir).toHaveBeenCalledWith('emision', 'secretos', 'auditoria');
    expect(repo.guardar).toHaveBeenCalledWith(
      { [CLAVE_POS_BETA_ACTIVO]: 'true' },
      expect.objectContaining({ query: expect.any(Function) }),
    );
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'POS_BETA_ACTIVADO', id_usuario: 7 }),
      expect.objectContaining({ query: expect.any(Function) }),
    );
    expect(resultado).toMatchObject({ habilitado: true, activo: true, listo: true });
  });
});
