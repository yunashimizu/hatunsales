import type { CertificadoParaChecklist, HechosPreparacion } from './checklist-activacion';
import { construirSnapshot, DefectosEntornoFiscal } from './snapshot-config-fiscal';

/** Fábricas para las pruebas de configuración (no entra al build ni es suite de jest). */

export const AHORA_PRUEBA = new Date('2026-10-13T15:00:00Z');
const DIA = 24 * 3600 * 1000;

export const DEFECTOS_PRUEBA: DefectosEntornoFiscal = {
  ambiente: 'beta',
  serieFactura: 'F001',
  serieBoleta: 'B001',
  serieGuia: 'T001',
  emisor: {
    ruc: '20610206337',
    razonSocial: 'HATUNSALES S.A.C.',
    direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
    ubicacion: 'LURIN - LIMA - LIMA',
  },
};

/** Configuración COMPLETA para producción (todo lo que pide el checklist). */
export const VALORES_COMPLETOS: Record<string, string> = {
  fiscal_proveedor: 'nubefact',
  fiscal_ambiente: 'produccion',
  fiscal_sol_usuario: 'HATUN001',
  emisor_ubigeo: '150119',
  emisor_codigo_establecimiento: '0000',
  fiscal_confirmacion_no_ose: JSON.stringify({ id_usuario: 1, nombre: 'Admin', fecha: '2026-10-10T10:00:00.000Z' }),
};

export function snapshotPrueba(valores: Record<string, string | null> = VALORES_COMPLETOS) {
  return construirSnapshot(valores, DEFECTOS_PRUEBA);
}

export function certificadoPrueba(cambios: Partial<CertificadoParaChecklist> = {}): CertificadoParaChecklist {
  return {
    ruc: '20610206337',
    vigenteDesde: new Date(AHORA_PRUEBA.getTime() - 30 * DIA),
    vigenteHasta: new Date(AHORA_PRUEBA.getTime() + 900 * DIA),
    autofirmado: false,
    bitsClave: 2048,
    legible: true,
    ...cambios,
  };
}

export function hechosPrueba(cambios: Partial<HechosPreparacion> = {}): HechosPreparacion {
  return {
    snapshot: snapshotPrueba(),
    ahora: AHORA_PRUEBA,
    esquema: { listo: true, faltantes: [] },
    cifradoDisponible: true,
    certificados: { beta: null, produccion: certificadoPrueba() },
    claveSol: 'ok',
    credencialesGre: 'ok',
    ...cambios,
  };
}
