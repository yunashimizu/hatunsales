import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import type { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import type { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { evaluarPreparacion } from './checklist-activacion';
import type { RepositorioConfigFiscal } from './config-fiscal.repository';
import { hechosPrueba, snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
import type { FiscalConfigService } from './fiscal-config.service';
import type { SnapshotConfigFiscal } from './fiscal-config.tipos';
import type { FiscalEsquemaService } from './fiscal-esquema.service';
import { GestorConfigFiscalService } from './gestor-config-fiscal.service';
import type { InterruptorEmisionFiscal } from './interruptor-emision.service';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import type { PreparacionFiscalService } from './preparacion-fiscal.service';
import { RelojFiscal } from './reloj-fiscal';
import type { TransaccionesFiscales } from './transacciones-fiscales';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-10-13T15:00:00Z');
  }
}

const ACTOR = { id_usuario: 7, nombre: 'Moisés', ip: '10.0.0.1' };

function crear(bloqueoAnterior: object | null) {
  const snapshot = snapshotPrueba({ ...VALORES_COMPLETOS, fiscal_ambiente: 'beta' });
  const config = {
    snapshot: async () => snapshot,
    snapshotFresco: async () => snapshot,
    proveedorActivo: async () => snapshot.proveedor,
  };
  const repositorio = { guardar: jest.fn(async () => undefined), leer: jest.fn(async () => ({})) };
  const tx = { query: jest.fn(async () => []) };
  const transacciones = { ejecutar: jest.fn(async (trabajo: (e: typeof tx) => Promise<unknown>) => trabajo(tx)) };
  const preparacion = {
    evaluar: jest.fn(async (s: SnapshotConfigFiscal) => evaluarPreparacion(hechosPrueba({ snapshot: s }))),
  };
  const interruptor = { limpiar: jest.fn(async () => bloqueoAnterior) };
  const gestor = new GestorConfigFiscalService(
    config as unknown as FiscalConfigService,
    repositorio as unknown as RepositorioConfigFiscal,
    transacciones as unknown as TransaccionesFiscales,
    preparacion as unknown as PreparacionFiscalService,
    { infoTodos: async () => ({ beta: null, produccion: null }) } as unknown as CertificadoFiscalService,
    {
      guardarClave: jest.fn(async () => undefined),
      estado: async () => ({ usuario: 'HATUN002', tiene_clave: true, actualizado_en: null }),
    } as unknown as CredencialesSolService,
    { estado: async () => ({ tiene_credenciales: false }) } as unknown as CredencialesGreService,
    { registrar: jest.fn(async () => undefined) } as unknown as FiscalAuditoriaRepository,
    {
      exigir: async () => undefined,
      estado: async () => ({ listo: true, verificado: true, mensaje: null, faltantes: [] }),
    } as unknown as FiscalEsquemaService,
    { exigirDisponible: () => undefined, diagnostico: () => ({ disponible: true, problema: null }) } as unknown as CifradoFiscalService,
    new NotificadorCambiosFiscales(),
    new RelojPrueba(),
    interruptor as unknown as InterruptorEmisionFiscal,
  );
  return { gestor, interruptor, tx };
}

describe('GestorConfigFiscalService: credenciales SOL y el interruptor de producción (D5.4)', () => {
  it('guardar nuevas credenciales SOL reanuda la emisión de producción detenida (en la misma transacción) y lo advierte', async () => {
    const { gestor, interruptor, tx } = crear({ codigo: '0102', motivo: 'Clave incorrecta', fecha: '2026-10-13' });
    const resultado = await gestor.guardar({ sol: { usuario: 'HATUN002', clave: 'Secreta#12' } }, ACTOR);
    expect(interruptor.limpiar).toHaveBeenCalledWith('produccion', 'credenciales SOL actualizadas', ACTOR, tx);
    expect(resultado.advertencias.join(' ')).toMatch(/se reanudó/);
  });

  it('otros cambios no tocan el interruptor', async () => {
    const { gestor, interruptor } = crear(null);
    const resultado = await gestor.guardar({ envio_en_linea: false }, ACTOR);
    expect(interruptor.limpiar).not.toHaveBeenCalled();
    expect(resultado.advertencias).toEqual([]);
  });

  it('la vista expone correlativo inicial, confirmaciones e interruptores (solo lectura) y ya no habla de Nubefact', async () => {
    const { gestor } = crear(null);
    const vista = await gestor.obtenerConfigCompleta();
    expect(vista.correlativo_inicial).toEqual({ F001: 1, B001: 1, FC01: 1, BC01: 1, FD01: 1, BD01: 1 });
    expect(vista.correlativo_inicial_revisado).toBe(true);
    expect(vista.confirmaciones).toEqual({ emisor_electronico_sol: true, certificado_en_sol: true, usuario_sol_secundario: true, ruc_habido: true });
    expect(vista.cert_ruc_confirmado).toBe(false);
    expect(vista.emision_bloqueada).toEqual({ beta: null, produccion: null });
    expect(vista.estado).not.toHaveProperty('nubefact_configurado');
    expect(vista.aviso_legal_ose.texto).not.toMatch(/siga emitiendo con Nubefact/);
    expect(vista.aviso_legal_ose.normas).toEqual(['RS 117-2017/SUNAT', 'RS 239-2018/SUNAT']);
  });
});
