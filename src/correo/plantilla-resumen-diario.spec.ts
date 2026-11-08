import { armarCorreoResumenDiario, DatosResumenDiario, fechaLarga, soles, variacion } from './plantilla-resumen-diario';

const dia = (fecha: string, total: number, ventas: number) => ({
  fecha,
  total,
  ventas,
  ticket_promedio: ventas ? Math.round((total / ventas) * 100) / 100 : 0,
});

const base: DatosResumenDiario = {
  fecha: '2026-11-05',
  negocio: 'HATUNSALES S.A.C.',
  ventas: { hoy: dia('2026-11-05', 1250.5, 10), ayer: dia('2026-11-04', 1000, 8), semana_pasada: dia('2026-10-29', 1500, 12) },
  caja: { total: 900, turnos_abiertos: 1, por_metodo: [{ metodo: 'Efectivo', monto: 600 }, { metodo: 'Yape', monto: 300 }] },
  comprobantes: { pendientes: 2, errores: 1, recientes: [{ numero: 'B001-00000012', estado: 'con error' }] },
  deuda: { cuentas: 2, total: 1800, mayores: [{ deudor: 'Constructora <Andina>', saldo: 1500, dias: 12, comprobante: 'F001-00000030' }] },
  stock: { sin_stock: 3, bajo_stock: 5, criticos: [{ producto: 'Cemento Sol', almacen: 'Principal', stock: 0, minimo: 20 }] },
  pedidos: { pendientes: 4, pagados: 2 },
};

describe('armarCorreoResumenDiario', () => {
  it('arma el asunto con la fecha y las ventas, y el texto con cada sección', () => {
    const c = armarCorreoResumenDiario(base);

    expect(c.asunto).toBe('Resumen del 05/11/2026 – HATUNSALES S.A.C. – Ventas S/ 1,250.50');
    expect(c.texto).toContain('RESUMEN DEL DÍA · JUEVES 5 DE NOVIEMBRE DE 2026');
    expect(c.texto).toContain('Hoy: S/ 1,250.50 · 10 comprobantes · ticket S/ 125.05');
    expect(c.texto).toContain('Ayer: S/ 1,000.00 · 8 comprobantes (+25 %)');
    expect(c.texto).toContain('Mismo día de la semana pasada (29/10/2026): S/ 1,500.00 · 12 comprobantes (-17 %)');
    expect(c.texto).toContain('Yape: S/ 300.00');
    expect(c.texto).toContain('1 caja(s) sin cerrar');
    expect(c.texto).toContain('Pendientes de envío: 2 · Con error: 1');
    expect(c.texto).toContain('- Constructora <Andina>: S/ 1,500.00 (hace 12 días, F001-00000030)');
    expect(c.texto).toContain('- Cemento Sol (Principal): 0 de mínimo 20');
    expect(c.texto).toContain('Pagados por preparar: 2');
    expect(c.html).toContain('#2b2c2b');
    expect(c.html).toContain('#b8975a');
    expect(c.html).not.toMatch(/<img|src=|http/i);
  });

  it('escapa el HTML de los datos y deja un aviso en la sección que no se pudo leer', () => {
    const c = armarCorreoResumenDiario({ ...base, caja: null, stock: null });

    expect(c.html).toContain('Constructora &lt;Andina&gt;');
    expect(c.html).not.toContain('<Andina>');
    expect(c.html.match(/No se pudo leer esta sección/g)).toHaveLength(2);
    expect(c.texto).toContain('COBROS DEL DÍA (CAJA)\nNo se pudo leer esta sección.');
  });

  it('marca el correo de prueba, dice «todo en orden» sin problemas y no inventa variaciones sin referencia', () => {
    const limpio: DatosResumenDiario = {
      ...base,
      esPrueba: true,
      ventas: { hoy: dia('2026-11-05', 100, 1), ayer: dia('2026-11-04', 0, 0), semana_pasada: dia('2026-10-29', 0, 0) },
      caja: { total: 0, turnos_abiertos: 0, por_metodo: [] },
      comprobantes: { pendientes: 0, errores: 0, recientes: [] },
      deuda: { cuentas: 0, total: 0, mayores: [] },
      stock: { sin_stock: 0, bajo_stock: 0, criticos: [] },
    };
    const c = armarCorreoResumenDiario(limpio);

    expect(c.asunto.startsWith('PRUEBA – Resumen del 05/11/2026')).toBe(true);
    expect(c.html).toContain('Correo de prueba');
    expect(c.texto).toContain('Ayer: S/ 0.00 · 0 comprobantes (sin referencia)');
    expect(c.texto).toContain('No hubo cobros registrados en caja.');
    expect(c.texto).toContain('Ninguno. Todo en orden.');
    expect(c.texto).toContain('No hay deuda vencida.');
    expect(c.texto).toContain('Sin alertas de stock.');
  });

  it('formatea soles, fechas largas y variaciones', () => {
    expect(soles(1234567.891)).toBe('S/ 1,234,567.89');
    expect(soles(-5)).toBe('-S/ 5.00');
    expect(fechaLarga('2026-11-08')).toBe('domingo 8 de noviembre de 2026');
    expect(variacion(120, 100)).toEqual({ texto: '+20 %', signo: 1 });
    expect(variacion(80, 100)).toEqual({ texto: '-20 %', signo: -1 });
    expect(variacion(5, 0).signo).toBeNull();
  });
});
