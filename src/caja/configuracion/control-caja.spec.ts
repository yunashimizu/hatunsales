import { BadRequestException, Logger } from '@nestjs/common';
import {
  CATEGORIAS_GASTO,
  configControlCajaDesdeValores,
  CONTROL_CAJA_POR_DEFECTO,
  diasMoraDeTexto,
  horasCierreDeTexto,
  ocultaEsperadoA,
  validarCambioControlCaja,
} from './control-caja';
import { ControlCajaService } from './control-caja.service';

describe('control-caja (Fase 7, utilidad pura)', () => {
  it('sin ninguna clave: crédito con abonos se bloquea, arqueo ciego apagado, cierre automático apagado', () => {
    expect(configControlCajaDesdeValores({})).toEqual({
      anulacion_credito_con_abonos: 'bloquear',
      arqueo_ciego: false,
      caja_cierre_automatico_horas: 0,
      credito_bloqueo_mora_dias: 0,
    });
    expect(CONTROL_CAJA_POR_DEFECTO).toEqual(configControlCajaDesdeValores({}));
  });

  it('lee lo guardado; un valor raro de 7.2 sigue bloqueando y uno raro de horas apaga', () => {
    expect(
      configControlCajaDesdeValores({ anulacion_credito_con_abonos: ' PERMITIR ', arqueo_ciego: 'true', caja_cierre_automatico_horas: '16' }),
    ).toEqual({ anulacion_credito_con_abonos: 'permitir', arqueo_ciego: true, caja_cierre_automatico_horas: 16, credito_bloqueo_mora_dias: 0 });
    expect(configControlCajaDesdeValores({ anulacion_credito_con_abonos: 'quizas', arqueo_ciego: 'no' })).toMatchObject({
      anulacion_credito_con_abonos: 'bloquear',
      arqueo_ciego: false,
    });
    expect(horasCierreDeTexto('abc')).toBe(0);
    expect(horasCierreDeTexto('-3')).toBe(0);
    expect(horasCierreDeTexto('2')).toBe(8); // nunca corta un turno normal
    expect(horasCierreDeTexto('500')).toBe(72);
  });

  it('valida el cambio: solo lo que llega, con mensajes claros', () => {
    expect(validarCambioControlCaja({})).toEqual({});
    expect(validarCambioControlCaja({ arqueo_ciego: true, caja_cierre_automatico_horas: 16 })).toEqual({ arqueo_ciego: true, caja_cierre_automatico_horas: 16 });
    expect(validarCambioControlCaja({ caja_cierre_automatico_horas: 0 })).toEqual({ caja_cierre_automatico_horas: 0 });
    expect(() => validarCambioControlCaja({ anulacion_credito_con_abonos: 'a veces' })).toThrow('bloquear, permitir');
    expect(() => validarCambioControlCaja({ arqueo_ciego: 'si' })).toThrow('verdadero o falso');
    for (const malo of [4, 73, 16.5, '']) expect(() => validarCambioControlCaja({ caja_cierre_automatico_horas: malo })).toThrow('entre 8 y 72');
  });

  it('el arqueo ciego oculta a caja y vendedor, nunca al admin, y nada con la clave apagada', () => {
    expect(ocultaEsperadoA('caja', true)).toBe(true);
    expect(ocultaEsperadoA('vendedor', true)).toBe(true);
    expect(ocultaEsperadoA('admin', true)).toBe(false);
    expect(ocultaEsperadoA('caja', false)).toBe(false);
  });

  it('categorías del gasto: lista corta y cerrada', () => {
    expect(CATEGORIAS_GASTO).toEqual(['transporte', 'servicios', 'compras_menores', 'devolucion', 'otro']);
  });
});

describe('ControlCajaService', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));

  function armar(valores: Record<string, string | null> = {}) {
    const guardados: Record<string, string> = {};
    const config = {
      obtenerVarias: jest.fn(async (claves: string[]) => Object.fromEntries(claves.map((c) => [c, guardados[c] ?? valores[c] ?? null]))),
      guardar: jest.fn(async (clave: string, valor: string) => {
        guardados[clave] = valor;
      }),
    };
    const bitacora = { registrarCon: jest.fn(async (f: () => unknown) => f()) };
    return { servicio: new ControlCajaService(config as never, bitacora as never), config, bitacora };
  }

  it('las lecturas de la operación nunca lanzan: ante un fallo, los valores por defecto', async () => {
    const { servicio, config } = armar();
    config.obtenerVarias.mockRejectedValue(new Error('sin conexión'));
    expect(await servicio.arqueoCiego()).toBe(false);
    expect(await servicio.horasCierreAutomatico()).toBe(0);
    expect(await servicio.modoAnulacionCredito()).toBe('bloquear');
  });

  it('guardar escribe solo lo que cambió y lo anota en la bitácora con antes y después', async () => {
    const { servicio, config, bitacora } = armar({ arqueo_ciego: 'false' });
    const r = await servicio.guardar({ arqueo_ciego: true, anulacion_credito_con_abonos: 'bloquear' }, { id_usuario: 1, rol: 'admin' } as never);
    expect(r.arqueo_ciego).toBe(true);
    expect(config.guardar).toHaveBeenCalledTimes(1);
    expect(config.guardar).toHaveBeenCalledWith('arqueo_ciego', 'true');
    expect(await bitacora.registrarCon.mock.results[0].value).toMatchObject({
      accion: 'configuracion.control_caja',
      antes: { arqueo_ciego: false },
      despues: { arqueo_ciego: true },
    });
    // Sin cambios: ni escribe ni anota.
    await servicio.guardar({ arqueo_ciego: true });
    expect(config.guardar).toHaveBeenCalledTimes(1);
    expect(bitacora.registrarCon).toHaveBeenCalledTimes(1);
  });

  it('un cambio inválido responde 400 sin escribir', async () => {
    const { servicio, config } = armar();
    await expect(servicio.guardar({ caja_cierre_automatico_horas: 3 })).rejects.toBeInstanceOf(BadRequestException);
    expect(config.guardar).not.toHaveBeenCalled();
  });

  it('9.4: credito_bloqueo_mora_dias nace en 0 (apagado), se lee 1–365 y se valida al guardar', async () => {
    expect(diasMoraDeTexto(null)).toBe(0);
    expect(diasMoraDeTexto('abc')).toBe(0);
    expect(diasMoraDeTexto('-5')).toBe(0);
    expect(diasMoraDeTexto('30')).toBe(30);
    expect(diasMoraDeTexto('9999')).toBe(365);
    expect(validarCambioControlCaja({ credito_bloqueo_mora_dias: 15 })).toEqual({ credito_bloqueo_mora_dias: 15 });
    expect(() => validarCambioControlCaja({ credito_bloqueo_mora_dias: 2.5 })).toThrow(/credito_bloqueo_mora_dias/);
    expect(() => validarCambioControlCaja({ credito_bloqueo_mora_dias: 400 })).toThrow(/365/);

    const { servicio, config } = armar();
    expect(await servicio.diasBloqueoMora()).toBe(0);
    await servicio.guardar({ credito_bloqueo_mora_dias: 30 }, { id_usuario: 1, rol: 'admin' } as never);
    expect(config.guardar).toHaveBeenCalledWith('credito_bloqueo_mora_dias', '30');
    expect(await servicio.diasBloqueoMora()).toBe(30);
    config.obtenerVarias.mockRejectedValue(new Error('sin conexión'));
    expect(await servicio.diasBloqueoMora()).toBe(0);
  });
});
