import {
  condicionBusquedaProductos,
  MAXIMO_PALABRAS_BUSQUEDA,
  normalizarTextoBusqueda,
  palabrasDeBusqueda,
  patronPalabra,
} from './busqueda-productos.util';

describe('búsqueda de productos tolerante', () => {
  it('normaliza tildes, eñe, mayúsculas y espacios', () => {
    expect(normalizarTextoBusqueda('  Caña   PARA\tPescar ')).toBe('cana para pescar');
    expect(normalizarTextoBusqueda(null)).toBe('');
  });

  it('separa palabras, quita repetidas y acota la cantidad', () => {
    expect(palabrasDeBusqueda('Tubo PVC pvc 4')).toEqual(['tubo', 'pvc', '4']);
    expect(palabrasDeBusqueda('a b c d e f g h')).toHaveLength(MAXIMO_PALABRAS_BUSQUEDA);
    expect(palabrasDeBusqueda('   ')).toEqual([]);
  });

  it('escapa %, _ y \\ para que no sean comodines', () => {
    expect(patronPalabra('50%')).toBe('%50\\%%');
    expect(patronPalabra('a_b')).toBe('%a\\_b%');
    expect(patronPalabra('a\\b')).toBe('%a\\\\b%');
  });

  it('todo valor del usuario va a parámetros: el SQL solo trae marcadores y constantes', () => {
    const peligro = "x'; DROP TABLE productos; --";
    const c = condicionBusquedaProductos(peligro, 3);
    expect(c.sql).not.toContain('DROP');
    expect(c.sql).not.toContain("x'");
    expect(c.sql).toMatch(/\$3/);
    expect(c.params.some((p) => p.includes('drop'))).toBe(true);
  });

  it('una palabra por marcador más uno para el código de barras, numerados desde el primero libre', () => {
    const c = condicionBusquedaProductos('cana pescar', 5);
    expect(c.params).toEqual(['%cana%', '%pescar%', '%cana pescar%']);
    expect(c.sql).toContain('$5');
    expect(c.sql).toContain('$6');
    expect(c.sql).toContain('$7');
    expect(c.sql).not.toContain('$8');
    expect(c.sql.match(/ AND /g)).toHaveLength(1);
    expect(c.sql).toContain("ESCAPE '\\'");
  });

  it('el barras se busca con el texto entero, no por palabras', () => {
    const c = condicionBusquedaProductos('7750 0001', 1);
    expect(c.params[c.params.length - 1]).toBe('%7750 0001%');
  });

  it('texto vacío no filtra', () => {
    expect(condicionBusquedaProductos('   ', 2)).toEqual({ sql: 'TRUE', params: [] });
  });

  it('quita las tildes del producto con translate, sin extensiones', () => {
    const c = condicionBusquedaProductos('x', 1);
    expect(c.sql).toContain('translate(');
    expect(c.sql).not.toMatch(/unaccent/i);
  });
});
