import { ProformaBussnies } from './proforma.bussnies';
import { WhatsappPasarela } from '../../util/pasarela/whatsapp.pasarela';

// La primera prueba carga y reduce el logo real: en frío puede superar los 5 s por defecto.
jest.setTimeout(30_000);

/**
 * Cableado de la proforma: la configuración del emisor (contacto, condiciones)
 * debe llegar al PDF, al Excel y al mensaje de WhatsApp, con las mismas cifras.
 */
function armar(configuracion: Record<string, string | null> = {}) {
  const proforma = {
    id_proforma: 7,
    codigo: 'COT-000007',
    estado: 'borrador',
    empresa: { id_empresa: 3, razon_social: 'CONSTRUCTORA ANDINA S.A.C.', ruc: '20512345678', direccion: 'AV. LOS CONSTRUCTORES 1520', telefonos: '987654321' },
    cliente: null,
    cliente_nombre_snapshot: null,
    telefono_envio: '987654321',
    id_almacen: 1,
    observaciones: 'Entrega en obra.',
    valida_hasta: '2099-10-01',
    creado_en: new Date('2026-09-24T15:00:00Z'),
    total_gravada: 6042.88,
    total_igv: 1087.72,
    total: 7130.6,
    porcentaje_igv: 18,
    id_venta: null,
    enviada_wa_en: null,
    items: [
      { id_producto: 1, cantidad: 50, precio_unitario: 28.9, subtotal: 1445, descripcion_snapshot: 'Cemento Sol Tipo I', sku_snapshot: 'CEM-SOL', unidad_medida_snapshot: 'BLS', descuento_snapshot: 0 },
      { id_producto: 2, cantidad: 120, precio_unitario: 18.5, subtotal: 2220, descripcion_snapshot: 'Fierro corrugado 8 mm', sku_snapshot: 'FIE-8MM', unidad_medida_snapshot: 'NIU', descuento_snapshot: 1.5 },
    ],
  };
  const repo = {
    getById: jest.fn().mockResolvedValue(proforma),
    nombresAlmacenes: jest.fn().mockResolvedValue(new Map([[1, 'Almacén Lurín']])),
    cuentasParaDocumento: jest.fn().mockResolvedValue([]),
    actualizar: jest.fn().mockResolvedValue(proforma),
  };
  const config = {
    obtenerVarias: jest.fn().mockResolvedValue(configuracion),
    obtenerNumero: jest.fn().mockResolvedValue(18),
    obtenerTexto: jest.fn(),
  };
  const servicio = new ProformaBussnies(repo as any, new WhatsappPasarela(), config as any);
  return { servicio, repo, config };
}

/** Catálogo falso para crear cotizaciones: una sola consulta para todos los ítems. */
function armarCreacion() {
  const catalogo = new Map<number, any>([
    [1, { id_producto: 1, nombre: 'Cemento Sol Tipo I', sku: 'CEM-SOL', precio_venta: '28.90', descuento: '0', unidad_medida: 'BLS' }],
    [2, { id_producto: 2, nombre: 'Fierro corrugado 8 mm', sku: 'FIE-8MM', precio_venta: '20.00', descuento: '1.50', unidad_medida: 'NIU' }],
    [3, { id_producto: 3, nombre: 'Alambre N° 16', sku: 'ALA-16', precio_venta: '6.50', descuento: '0', unidad_medida: 'KGM' }],
  ]);
  const repo = {
    productosPorId: jest.fn(async (ids: number[]) => new Map(ids.filter((id) => catalogo.has(id)).map((id) => [id, catalogo.get(id)]))),
    crearConItems: jest.fn(async (datos: any) => ({ id_proforma: 11, codigo: 'COT-000011', id_almacen: null, ...datos })),
    nombresAlmacenes: jest.fn().mockResolvedValue(new Map()),
  };
  const config = { obtenerNumero: jest.fn().mockResolvedValue(18), obtenerVarias: jest.fn(), obtenerTexto: jest.fn() };
  const servicio = new ProformaBussnies(repo as any, new WhatsappPasarela(), config as any);
  return { servicio, repo };
}

describe('ProformaBussnies.create · productos en una sola consulta', () => {
  it('una cotización de 3 líneas lee el catálogo una sola vez', async () => {
    const { servicio, repo } = armarCreacion();

    await servicio.create({
      cliente_nombre: 'Obra Lurín',
      items: [
        { id_producto: 1, cantidad: 10, precio_unitario: 0 },
        { id_producto: 2, cantidad: 5, precio_unitario: 0 },
        { id_producto: 3, cantidad: 2, precio_unitario: 0 },
      ],
    } as any);

    expect(repo.productosPorId).toHaveBeenCalledTimes(1);
    expect(repo.productosPorId).toHaveBeenCalledWith([1, 2, 3]);
    const guardado = repo.crearConItems.mock.calls[0][0];
    expect(guardado.items.map((i: any) => [i.id_producto, i.precio_unitario])).toEqual([
      [1, 28.9],
      [2, 18.5],
      [3, 6.5],
    ]);
  });

  it('conserva los mensajes por ítem: producto inexistente y cantidad inválida', async () => {
    const { servicio } = armarCreacion();

    await expect(
      servicio.create({ cliente_nombre: 'X', items: [{ id_producto: 99, cantidad: 1, precio_unitario: 0 }] } as any),
    ).rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'COTIZACION_PRODUCTO_NO_ENCONTRADO' }) });

    await expect(
      servicio.create({ cliente_nombre: 'X', items: [{ id_producto: 2, cantidad: 1.5, precio_unitario: 0 }] } as any),
    ).rejects.toThrow('La cantidad de "Fierro corrugado 8 mm" debe ser un número entero de 1 o más');
  });
});

describe('ProformaBussnies.getById · unidad y descuento por ítem', () => {
  it('devuelve unidad_medida y descuento de cada ítem (snapshot, o producto, o NIU y 0)', async () => {
    const { servicio, repo } = armar();
    const base = await repo.getById();
    repo.getById.mockResolvedValue({
      ...base,
      items: [
        ...base.items,
        { id_producto: 3, cantidad: 1, precio_unitario: 6.5, subtotal: 6.5, producto: { unidad_medida: 'KGM', descuento: '0.5' } },
        { id_producto: 4, cantidad: 1, precio_unitario: 1, subtotal: 1 },
      ],
    });
    const r = await servicio.getById(7);
    expect(r.items.map((i) => [i.unidad_medida, i.descuento])).toEqual([
      ['BLS', 0],
      ['NIU', 1.5],
      ['KGM', 0.5],
      ['NIU', 0],
    ]);
  });
});

describe('ProformaBussnies · documentos y WhatsApp', () => {
  it('genera PDF y Excel con el nombre de archivo de la proforma', async () => {
    const { servicio } = armar();
    const pdf = await servicio.generarPdf(7);
    const excel = await servicio.generarExcel(7);
    expect(pdf.nombreArchivo).toBe('Proforma-COT-000007.pdf');
    expect(excel.nombreArchivo).toBe('Proforma-COT-000007.xlsx');
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(excel.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('lee de una sola vez el contacto y las condiciones del emisor', async () => {
    const { servicio, config } = armar({
      emisor_telefono: '987654321',
      emisor_email: 'ventas@hatunsales.pe',
      proforma_condiciones: 'Entrega en 24 horas.\n\nPago contra entrega.',
    });
    await servicio.generarPdf(7);
    const claves = config.obtenerVarias.mock.calls[0][0] as string[];
    expect(claves).toEqual(expect.arrayContaining(['emisor_telefono', 'emisor_email', 'emisor_web', 'proforma_condiciones']));
    expect(config.obtenerVarias).toHaveBeenCalledTimes(1);
  });

  it('el mensaje de WhatsApp sale con formato del documento, teléfono del emisor y enlace wa.me al cliente', async () => {
    const { servicio, repo } = armar({ emisor_telefono: '912345678' });
    const r: any = await servicio.enviarPorWhatsapp({ id_proforma: 7, telefono: '987654321' });

    expect(r.modo).toBe('wa_me');
    expect(r.wa_me_url).toMatch(/^https:\/\/wa\.me\/51987654321\?text=/);
    const texto = decodeURIComponent(r.wa_me_url.split('?text=')[1]);
    expect(texto).toBe(r.texto);
    expect(texto).toContain('Estimados señores de CONSTRUCTORA ANDINA S.A.C.:');
    expect(texto).toContain('*TOTAL: S/ 7,130.60*');
    expect(texto).toContain('01/10/2099');
    expect(texto).toContain('llámenos al 912 345 678');
    // Se anota el envío: la cotización pasa de borrador a enviada.
    expect(repo.actualizar).toHaveBeenCalledWith(7, expect.objectContaining({ estado: 'enviada', telefono_envio: '51987654321' }));
  });

  it('rechaza un celular inválido con código de error', async () => {
    const { servicio } = armar();
    await expect(servicio.enviarPorWhatsapp({ id_proforma: 7, telefono: '123' })).rejects.toMatchObject({
      response: expect.objectContaining({ codigo: 'COTIZACION_TELEFONO_INVALIDO' }),
    });
  });
});
