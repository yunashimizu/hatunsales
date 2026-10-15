import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { FiscalAdminController } from '../admin/fiscal-admin.controller';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { GestorConfigFiscalService } from '../config/gestor-config-fiscal.service';
import { SaludFiscalService } from '../config/salud-fiscal.service';
import { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { REGISTRO_SUNAT_CONFIG } from './config.registro';

/**
 * Integración de la inyección de dependencias del registro (sin BD real):
 * todo se resuelve, no hay ciclos, y con una BD vacía el comportamiento es el
 * de hoy (Nubefact, BETA, GRE apagada).
 */
describe('REGISTRO_SUNAT_CONFIG', () => {
  const consultas: string[] = [];
  const dataSourceVacio = {
    query: jest.fn(async (sql: string) => {
      consultas.push(sql);
      return [];
    }),
    transaction: jest.fn(),
  };

  async function compilar() {
    return Test.createTestingModule({
      controllers: REGISTRO_SUNAT_CONFIG.controladores,
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ConfiguracionRepository,
        { provide: getDataSourceToken('pgConnection'), useValue: dataSourceVacio },
      ],
    }).compile();
  }

  it('resuelve todos los proveedores y el controlador', async () => {
    const modulo = await compilar();
    expect(modulo.get(FiscalAdminController)).toBeInstanceOf(FiscalAdminController);
    expect(modulo.get(CertificadoFiscalService)).toBeInstanceOf(CertificadoFiscalService);
    expect(modulo.get(CredencialesGreService)).toBeInstanceOf(CredencialesGreService);
    expect(modulo.get(SaludFiscalService)).toBeInstanceOf(SaludFiscalService);
  });

  it('con la BD vacía: Nubefact por defecto, GRE apagada y el checklist se evalúa sin fallar', async () => {
    const modulo = await compilar();
    const config = modulo.get(FiscalConfigService);
    expect(await config.proveedorActivo()).toBe('nubefact');
    expect(await config.greActiva()).toBe(false);
    expect(await config.serieParaTipo('09')).toBe('T001');

    const vista = await modulo.get(GestorConfigFiscalService).obtenerConfigCompleta();
    expect(vista.proveedor).toBe('nubefact');
    expect(vista.estado.listo_para_produccion).toBe(false);
    expect(vista.estado.checklist.cpe.faltantes.length).toBeGreaterThan(0);
    expect(vista.tiene_credenciales_gre).toBe(false);

    const preparacion = await config.listoParaProduccion();
    expect(preparacion.checklist.gre.tipo).toBe('gre');
    // Solo lecturas parametrizadas: ningún DDL en tiempo de ejecución.
    expect(consultas.some((sql) => /\b(CREATE|ALTER|DROP)\b/i.test(sql))).toBe(false);
  });
});
