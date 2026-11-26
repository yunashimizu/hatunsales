import {
  configControlStockDesdeValores, CONTROL_STOCK_POR_DEFECTO, guiaNormalizada, horasVencimientoDeTexto, modoGuiaDeTexto,
  validarCambioControlStock,
} from './control-stock';

describe('control-stock (Fase 8): claves, valores por defecto y validación', () => {
  it('sin claves guardadas: nada vence y la guía repetida solo se avisa (como antes de la Fase 8)', () => {
    expect(configControlStockDesdeValores({})).toEqual(CONTROL_STOCK_POR_DEFECTO);
    expect(CONTROL_STOCK_POR_DEFECTO).toEqual({
      pedido_vencimiento_horas_pasarela: 0, pedido_vencimiento_horas_transferencia: 0, recepcion_guia_repetida: 'avisar',
    });
  });

  it('lo guardado se normaliza: ilegible o negativo = apagado; fuera de rango se acerca al límite', () => {
    expect(horasVencimientoDeTexto('24')).toBe(24);
    expect(horasVencimientoDeTexto('abc')).toBe(0);
    expect(horasVencimientoDeTexto('-5')).toBe(0);
    expect(horasVencimientoDeTexto('1')).toBe(2);
    expect(horasVencimientoDeTexto('9999')).toBe(720);
    expect(modoGuiaDeTexto('BLOQUEAR')).toBe('bloquear');
    expect(modoGuiaDeTexto('otra cosa')).toBe('avisar');
  });

  it('el cambio solo acepta 0 o 2–720 horas enteras y avisar/bloquear; devuelve solo lo que llegó', () => {
    expect(validarCambioControlStock({ pedido_vencimiento_horas_pasarela: 24 })).toEqual({ pedido_vencimiento_horas_pasarela: 24 });
    expect(validarCambioControlStock({ pedido_vencimiento_horas_transferencia: '0', recepcion_guia_repetida: 'Bloquear' }))
      .toEqual({ pedido_vencimiento_horas_transferencia: 0, recepcion_guia_repetida: 'bloquear' });
    expect(() => validarCambioControlStock({ pedido_vencimiento_horas_pasarela: 1 })).toThrow(/entre 2 y 720/);
    expect(() => validarCambioControlStock({ pedido_vencimiento_horas_pasarela: 24.5 })).toThrow();
    expect(() => validarCambioControlStock({ recepcion_guia_repetida: 'ignorar' })).toThrow(/avisar, bloquear/);
    expect(validarCambioControlStock({})).toEqual({});
  });

  it('la guía se compara sin espacios en los bordes y sin distinguir mayúsculas', () => {
    expect(guiaNormalizada('  t001-45 ')).toBe('T001-45');
  });
});
