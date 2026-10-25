import type { ModuleRef } from '@nestjs/core';
import type { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { evaluarPreparacion } from './checklist-activacion';
import { hechosPrueba, snapshotPrueba, VALORES_COMPLETOS } from './configuracion.prueba-spec';
import type { FiscalConfigService } from './fiscal-config.service';
import type { FiscalEsquemaService } from './fiscal-esquema.service';
import { FUENTE_ESTADO_OPERATIVO_FISCAL } from './fiscal-tokens';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import type { PreparacionFiscalService } from './preparacion-fiscal.service';
import { RelojFiscal } from './reloj-fiscal';
import { SaludFiscalService } from './salud-fiscal.service';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-10-13T15:00:00Z');
  }
}

const BLOQUEO = { codigo: '0102', motivo: 'SUNAT rechazó la clave SOL.', fecha: '2026-10-13T14:00:00.000Z' };

function crear(valores: Record<string, string>, operativo: Record<string, unknown> | null) {
  const snapshot = snapshotPrueba(valores);
  const config = {
    snapshot: jest.fn(async () => snapshot),
    proveedorActivo: jest.fn(async () => snapshot.proveedor),
    greActiva: jest.fn(async () => false),
  };
  const preparacion = { evaluar: jest.fn(async () => evaluarPreparacion(hechosPrueba({ snapshot }))) };
  const certificados = {
    infoTodos: jest.fn(async () => ({
      beta: null,
      produccion: { ambiente: 'produccion', dias_para_vencer: 120, vencido: false, autofirmado: false },
    })),
  };
  const esquema = { estado: jest.fn(async () => ({ listo: true, mensaje: null })) };
  const cifrado = { disponible: () => true };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token !== FUENTE_ESTADO_OPERATIVO_FISCAL || !operativo) throw new Error('no registrado');
      return { estadoOperativo: async () => operativo };
    }),
  };
  const servicio = new SaludFiscalService(
    config as unknown as FiscalConfigService,
    preparacion as unknown as PreparacionFiscalService,
    certificados as unknown as CertificadoFiscalService,
    esquema as unknown as FiscalEsquemaService,
    cifrado as unknown as CifradoFiscalService,
    new RelojPrueba(),
    moduleRef as unknown as ModuleRef,
    new NotificadorCambiosFiscales(),
  );
  return { servicio };
}

describe('GET /fiscal/estado (SaludFiscalService)', () => {
  it('agrega emisión, cola, plazos y los días que le quedan al certificado del ambiente', async () => {
    const { servicio } = crear(
      { ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo' },
      {
        emision: { activa: true, ambiente: 'produccion' },
        cola: { pendientes: 0, inciertos: 0 },
        plazos: { vencen_hoy: 0, vencidos: 0 },
        tareas: { activas: true, ultima_ejecucion: null },
      },
    );
    const estado = await servicio.estado();
    expect(estado).toMatchObject({
      emision: { activa: true, ambiente: 'produccion' },
      bloqueo: null,
      cola: { pendientes: 0, inciertos: 0 },
      plazos: { vencen_hoy: 0, vencidos: 0 },
      certificado: { dias_para_vencer: 120, vence_en_dias: 120 },
      semaforo: 'verde',
    });
  });

  it('con el interruptor abierto muestra el bloqueo y el semáforo en rojo', async () => {
    const { servicio } = crear(
      { ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo', fiscal_emision_bloqueada_produccion: JSON.stringify(BLOQUEO) },
      { emision: { activa: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_BLOQUEADA', motivo: 'detenida' } },
    );
    const estado = await servicio.estado();
    expect(estado.bloqueo).toEqual(BLOQUEO);
    expect(estado.emision).toMatchObject({ activa: false, codigo: 'FISCAL_EMISION_BLOQUEADA' });
    expect(estado.semaforo).toBe('rojo');
  });

  it('comprobantes que vencen hoy o envíos inciertos ponen el semáforo en amarillo; sin módulo de emisión, null', async () => {
    const conPendientes = crear(
      { ...VALORES_COMPLETOS, fiscal_proveedor: 'sunat_directo' },
      { emision: { activa: true, ambiente: 'produccion' }, cola: { pendientes: 0, inciertos: 1 }, plazos: { vencen_hoy: 0, vencidos: 0 } },
    );
    expect((await conPendientes.servicio.estado()).semaforo).toBe('amarillo');

    const sinModulo = crear(VALORES_COMPLETOS, null);
    expect(await sinModulo.servicio.estado()).toMatchObject({ emision: null, cola: null, plazos: null, bloqueo: null });
  });
});
