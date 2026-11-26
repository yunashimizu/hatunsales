import {
  CONFIG_CONTROL_REBAJA_POR_DEFECTO,
  ConfigControlRebaja,
  configControlDesdeValores,
  describirRebaja,
  evaluarLinea,
  evaluarRebajas,
  LineaParaControl,
  normalizarModoControl,
  normalizarSiNo,
  normalizarTopeRebaja,
  precioReferencia,
  rebajaVisible,
  requiereAutorizacion,
} from './control-rebaja';

const REGISTRAR: ConfigControlRebaja = { modo: 'registrar', tope_pct: 10, bajo_costo: true };
const AUTORIZAR: ConfigControlRebaja = { ...REGISTRAR, modo: 'autorizar' };

/** Cemento: S/ 10.00 en la base, sin descuento, costo S/ 7.50. */
function linea(parcial: Partial<LineaParaControl> = {}): LineaParaControl {
  return {
    id_producto: 7,
    descripcion: 'CEMENTO',
    cantidad: 1,
    precio_final: 10,
    precio_venta_base: 10,
    descuento_base: 0,
    reglas_mayoristas: [],
    costo_unitario: 7.5,
    ...parcial,
  };
}

describe('control-rebaja · configuración', () => {
  it('sin claves (SQL-6 no las inserta): registrar, tope 10 %, bajo costo controlado', () => {
    expect(configControlDesdeValores({})).toEqual({ modo: 'registrar', tope_pct: 10, bajo_costo: true });
    expect(configControlDesdeValores({ control_rebaja_modo: null, rebaja_max_pct_vendedor: null, control_bajo_costo: null }))
      .toEqual(CONFIG_CONTROL_REBAJA_POR_DEFECTO);
  });

  it('lee los tres valores guardados', () => {
    expect(configControlDesdeValores({ control_rebaja_modo: 'AUTORIZAR ', rebaja_max_pct_vendedor: '15,5', control_bajo_costo: 'no' }))
      .toEqual({ modo: 'autorizar', tope_pct: 15.5, bajo_costo: false });
  });

  it('modo desconocido o vacío → registrar (nunca bloquea por un error de tipeo)', () => {
    for (const v of ['', 'bloquear', null, undefined, 3]) expect(normalizarModoControl(v)).toBe('registrar');
    expect(normalizarModoControl('apagado')).toBe('apagado');
  });

  it('tope: fuera de 0–100, vacío o no numérico → 10; con 2 decimales', () => {
    for (const v of [null, undefined, '', 'abc', '-1', '101', 'Infinity']) expect(normalizarTopeRebaja(v)).toBe(10);
    expect(normalizarTopeRebaja('0')).toBe(0);
    expect(normalizarTopeRebaja('100')).toBe(100);
    expect(normalizarTopeRebaja('12.345')).toBe(12.35);
    expect(normalizarTopeRebaja(7)).toBe(7);
  });

  it('sí/no: reconoce las variantes y lo demás es el valor por defecto', () => {
    for (const v of ['true', '1', 'sí', 'SI', 'on', true]) expect(normalizarSiNo(v, false)).toBe(true);
    for (const v of ['false', '0', 'no', 'off', false]) expect(normalizarSiNo(v, true)).toBe(false);
    expect(normalizarSiNo('quizá', true)).toBe(true);
    expect(normalizarSiNo(null, false)).toBe(false);
  });
});

describe('control-rebaja · precio de referencia (catálogo neto de la base, R3)', () => {
  it('precio de venta menos el descuento de la ficha', () => {
    expect(precioReferencia(linea({ descuento_base: 0.5 }))).toBe(9.5);
  });

  it('la regla mayorista de ESA cantidad reemplaza al descuento (igual que resolverPrecioVenta)', () => {
    const reglas = [{ id_regla: 1, cantidad_minima: 10, descuento_unitario: 1.2 }];
    expect(precioReferencia(linea({ cantidad: 9, descuento_base: 0.5, reglas_mayoristas: reglas }))).toBe(9.5);
    expect(precioReferencia(linea({ cantidad: 10, descuento_base: 0.5, reglas_mayoristas: reglas }))).toBe(8.8);
  });

  it('sin precio en la base (0) o con descuento total: sin referencia', () => {
    expect(precioReferencia(linea({ precio_venta_base: 0 }))).toBeNull();
    expect(precioReferencia(linea({ descuento_base: 10 }))).toBeNull();
  });
});

describe('control-rebaja · evaluarLinea', () => {
  it('al precio de catálogo no hay rebaja', () => {
    expect(evaluarLinea(linea(), 0, REGISTRAR)).toMatchObject({ precio_referencia: 10, precio_final: 10, rebaja_pct: 0, sobre_tope: false, bajo_costo: false });
  });

  it('el descuento de la ficha y la regla mayorista no son rebaja manual', () => {
    const conFicha = evaluarLinea(linea({ descuento_base: 2, precio_final: 8 }), 0, REGISTRAR);
    expect(conFicha).toMatchObject({ precio_referencia: 8, rebaja_pct: 0, sobre_tope: false });
    const reglas = [{ id_regla: 1, cantidad_minima: 10, descuento_unitario: 3 }];
    const mayorista = evaluarLinea(linea({ cantidad: 12, reglas_mayoristas: reglas, precio_final: 7.6 }), 0, REGISTRAR);
    expect(mayorista).toMatchObject({ precio_referencia: 7, rebaja_pct: 0, sobre_tope: false });
  });

  it('vender más caro nunca es rebaja', () => {
    expect(evaluarLinea(linea({ precio_final: 14 }), 0, REGISTRAR)).toMatchObject({ rebaja_pct: 0, sobre_tope: false });
  });

  it('hasta el tope (10 %) pasa; un céntimo más allá de la tolerancia, no', () => {
    expect(evaluarLinea(linea({ precio_final: 9 }), 0, REGISTRAR)).toMatchObject({ rebaja_pct: 10, sobre_tope: false });
    // 10.1 % = 1 céntimo de más: dentro de la tolerancia.
    expect(evaluarLinea(linea({ precio_final: 8.99 }), 0, REGISTRAR)).toMatchObject({ rebaja_pct: 10.1, sobre_tope: false });
    expect(evaluarLinea(linea({ precio_final: 8.98 }), 0, REGISTRAR)).toMatchObject({ rebaja_pct: 10.2, sobre_tope: true });
    expect(evaluarLinea(linea({ precio_final: 7 }), 0, REGISTRAR)).toMatchObject({ rebaja_pct: 30, sobre_tope: true });
  });

  it('una diferencia de 1 céntimo no es rebaja, ni con tope 0', () => {
    const sinTope = { ...REGISTRAR, tope_pct: 0 };
    expect(evaluarLinea(linea({ precio_final: 9.99 }), 0, sinTope)).toMatchObject({ rebaja_pct: 0, sobre_tope: false });
    expect(evaluarLinea(linea({ precio_final: 9.98 }), 0, sinTope)).toMatchObject({ rebaja_pct: 0.2, sobre_tope: true });
  });

  it('el porcentaje se mide sobre la referencia neta, no sobre el precio de lista', () => {
    // Ficha: S/ 20 con S/ 4 de descuento → referencia 16. Cobrado 12 → 25 % (no 40 %).
    expect(evaluarLinea(linea({ precio_venta_base: 20, descuento_base: 4, precio_final: 12 }), 0, REGISTRAR))
      .toMatchObject({ precio_referencia: 16, rebaja_pct: 25, sobre_tope: true });
  });

  it('producto sin precio en la base: sin referencia, nunca es rebaja (sí puede ser bajo costo)', () => {
    expect(evaluarLinea(linea({ precio_venta_base: 0, precio_final: 9 }), 0, REGISTRAR))
      .toMatchObject({ precio_referencia: null, rebaja_pct: 0, sobre_tope: false, bajo_costo: false });
    expect(evaluarLinea(linea({ precio_venta_base: 0, precio_final: 5 }), 0, REGISTRAR))
      .toMatchObject({ precio_referencia: null, sobre_tope: false, bajo_costo: true });
  });

  it('bajo costo: precio final < costo, comparación directa, solo con costo > 0', () => {
    expect(evaluarLinea(linea({ precio_final: 7.49 }), 0, REGISTRAR).bajo_costo).toBe(true);
    expect(evaluarLinea(linea({ precio_final: 7.5 }), 0, REGISTRAR).bajo_costo).toBe(false);
    expect(evaluarLinea(linea({ precio_final: 1, costo_unitario: null }), 0, REGISTRAR).bajo_costo).toBe(false);
    expect(evaluarLinea(linea({ precio_final: 1, costo_unitario: 0 }), 0, REGISTRAR).bajo_costo).toBe(false);
    // Costo con 4 decimales: 7.4999 > 7.49.
    expect(evaluarLinea(linea({ precio_final: 7.49, costo_unitario: 7.4999 }), 0, REGISTRAR).bajo_costo).toBe(true);
  });

  it('con control_bajo_costo = no, el costo no se mira', () => {
    expect(evaluarLinea(linea({ precio_final: 1 }), 0, { ...REGISTRAR, bajo_costo: false }).bajo_costo).toBe(false);
  });

  it('el costo bajo puede venir sin rebaja sobre el tope (precio de catálogo por debajo del costo)', () => {
    const e = evaluarLinea(linea({ precio_venta_base: 7, precio_final: 7 }), 0, REGISTRAR);
    expect(e).toMatchObject({ sobre_tope: false, bajo_costo: true, rebaja_pct: 0 });
  });
});

describe('control-rebaja · evaluarRebajas y autorización', () => {
  const carrito = [
    linea({ id_producto: 1, descripcion: 'A', precio_final: 10 }),
    linea({ id_producto: 2, descripcion: 'B', precio_final: 8 }),
    linea({ id_producto: 3, descripcion: 'C', precio_final: 7 }),
  ];

  it('devuelve solo las líneas afectadas, con su posición en el carrito', () => {
    const r = evaluarRebajas(carrito, REGISTRAR);
    expect(r.map((e) => [e.indice, e.id_producto, e.sobre_tope, e.bajo_costo])).toEqual([
      [1, 2, true, false],
      [2, 3, true, true],
    ]);
  });

  it('apagado: nada; registrar: nunca pide autorización; autorizar: sí, si hay líneas', () => {
    expect(evaluarRebajas(carrito, { ...REGISTRAR, modo: 'apagado' })).toEqual([]);
    expect(requiereAutorizacion(evaluarRebajas(carrito, REGISTRAR), REGISTRAR)).toBe(false);
    expect(requiereAutorizacion(evaluarRebajas(carrito, AUTORIZAR), AUTORIZAR)).toBe(true);
    expect(requiereAutorizacion([], AUTORIZAR)).toBe(false);
  });

  it('la vista para el mostrador NUNCA trae el costo', () => {
    const [, c] = evaluarRebajas(carrito, AUTORIZAR);
    const visible = rebajaVisible(c, AUTORIZAR);
    expect(visible).toEqual({
      indice: 2, id_producto: 3, descripcion: 'C', cantidad: 1, precio_referencia: 10, precio_final: 7,
      rebaja_pct: 30, tope_pct: 10, sobre_tope: true, bajo_costo: true, requiere_autorizacion: true,
    });
    expect(JSON.stringify(visible)).not.toContain('7.5');
    expect(Object.keys(visible)).not.toContain('costo_unitario');
    expect(describirRebaja(c, AUTORIZAR)).not.toContain('7.50');
    expect(describirRebaja(c, AUTORIZAR)).toBe('C (S/ 7.00 en vez de S/ 10.00: 30% de rebaja, el tope es 10%; por debajo del costo)');
  });
});
