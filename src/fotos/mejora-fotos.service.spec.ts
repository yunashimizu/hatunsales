import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MejoraFotosService, nombreMejorada } from './mejora-fotos.service';
import { AlmacenEnMemoria, RepoMejoraEnMemoria } from './mejora-fotos.doble';
import { generarMuestras, MuestrasPrueba } from './muestras-prueba';
import type { ResultadoMejora } from './mejorador-imagen';

jest.setTimeout(60_000);

let m: MuestrasPrueba;
beforeAll(async () => {
  m = await generarMuestras();
});

function armar({ tabla = true, interruptor = true } = {}) {
  const repo = new RepoMejoraEnMemoria();
  repo.tabla = tabla;
  const almacen = new AlmacenEnMemoria();
  const config = { obtenerBooleano: jest.fn(async () => interruptor) };
  const imagenesRepo = {
    findOneById: jest.fn(async (id: number) => {
      const i = repo.imagenes.get(id);
      return i ? { ...i, producto: { id_producto: i.id_producto } } : null;
    }),
    findByProducto: jest.fn(async (id_producto: number) => [...repo.imagenes.values()].filter((i) => i.id_producto === id_producto)),
  };
  const almacenes = { resolver: jest.fn(() => almacen), leer: jest.fn(async (_p: string, clave: string) => {
    const a = await almacen.leer(Number(clave));
    return a ? { buffer: a.contenido, mime: a.mime } : null;
  }) };
  const servicio = new MejoraFotosService(repo as any, config as any, imagenesRepo as any, almacenes as any, almacen as any);
  return { servicio, repo, almacen, config, almacenes };
}

/** Sube un archivo al almacén falso y crea su fila de imagen apuntando a él (como hace la subida). */
async function imagenSubida(ctx: ReturnType<typeof armar>, id_imagen: number, buffer: Buffer, id_producto = 3) {
  const g = await ctx.almacen.guardar({ buffer, nombre_original: 'foto.jpg', mime: 'image/jpeg', carpeta: String(id_producto) });
  ctx.repo.imagenes.set(id_imagen, { id_imagen, id_producto, url: g.url, thumb_url: g.thumb_url, mime: g.mime, size: g.size, width: 10, height: 10, clave_almacen: g.clave, proveedor: g.proveedor });
  return g;
}

describe('MejoraFotosService.preparar', () => {
  it('foto buena ⇒ sin_cambios, sin archivo, con informe', async () => {
    const { servicio } = armar();
    const p = await servicio.preparar({ buffer: m.buena, mimetype: 'image/jpeg', originalname: 'a.jpg' });
    expect(p.estado).toBe('sin_cambios');
    expect(p.mejorada).toBeUndefined();
    expect(p.informe).toMatchObject({ version: 1, acciones: [], avisos: [] });
    expect(p.informe.medidas!.ancho).toBe(1200);
  });

  it('foto con borde ⇒ mejorada en JPEG, con RECORTE en el informe', async () => {
    const { servicio } = armar();
    const p = await servicio.preparar({ buffer: m.borde, mimetype: 'image/jpeg', originalname: 'a.jpg' });
    expect(p.estado).toBe('mejorada');
    expect(p.mejorada!.mime).toBe('image/jpeg');
    expect(p.informe.acciones).toEqual(['RECORTE']);
    expect(p.informe.despues).toBeDefined();
  });

  it('nunca lanza: un archivo roto devuelve «error» con el motivo', async () => {
    const { servicio } = armar();
    const p = await servicio.preparar({ buffer: Buffer.from('no es imagen'), mimetype: 'image/jpeg', originalname: 'roto.jpg' });
    expect(p.estado).toBe('error');
    expect(p.informe.motivo).toBe('error');
  });

  it('transparencia ⇒ omitida', async () => {
    const { servicio } = armar();
    const p = await servicio.preparar({ buffer: m.transparente, mimetype: 'image/png', originalname: 'a.png' });
    expect(p.estado).toBe('omitida');
    expect(p.informe.motivo).toBe('transparencia');
  });

  it('una a la vez: dos preparar lanzados juntos no se solapan', async () => {
    const { servicio } = armar();
    let enCurso = 0, maximo = 0;
    jest.spyOn(servicio as any, 'ejecutarMejora').mockImplementation(async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await new Promise((r) => setTimeout(r, 20));
      enCurso--;
      return resultadoSinCambios();
    });
    await Promise.all([1, 2, 3].map(() => servicio.preparar({ buffer: Buffer.alloc(1), mimetype: 'image/jpeg', originalname: 'x' })));
    expect(maximo).toBe(1);
  });
});

function resultadoSinCambios(): ResultadoMejora {
  return {
    estado: 'sin_cambios',
    analisis: { ancho: 1000, alto: 1000, formato: 'jpeg', orientacion: 1, alfa: false, paginas: 1, pixeles: 1e6, medidas: null, ms: 1 },
    receta: { cambia: false, acciones: [], avisos: [], escala: 1, anchoSalida: 1000, altoSalida: 1000 },
    ms: { analisis: 1, mejora: 0 },
  };
}

describe('MejoraFotosService.procesarSubida · presupuesto por petición', () => {
  it('con 100 ms por foto y 240 ms de presupuesto, de 4 fotos la tercera y la cuarta quedan pendientes y la petición no espera de más', async () => {
    const { servicio } = armar();
    servicio.presupuestoPorPeticionMs = 240;
    const espia = jest.spyOn(servicio as any, 'ejecutarMejora').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return resultadoSinCambios();
    });
    const presupuesto = servicio.nuevoPresupuesto();
    const inicio = Date.now();
    // Como en la subida: tres a la vez y la cuarta cuando se libera un lugar.
    const archivo = { buffer: Buffer.alloc(1), mimetype: 'image/jpeg', originalname: 'x' };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => servicio.procesarSubida(archivo, '3', presupuesto)));
    const d = await servicio.procesarSubida(archivo, '3', presupuesto);
    const ms = Date.now() - inicio;

    expect([a.estado, b.estado, c.estado, d.estado]).toEqual(['sin_cambios', 'sin_cambios', 'pendiente', 'pendiente']);
    expect(ms).toBeLessThan(400);
    expect(espia).toHaveBeenCalledTimes(3); // la cuarta ni siquiera entra: el presupuesto ya se agotó
  });

  it('mejorada ⇒ guarda el archivo mejorado (JPEG) en el almacén', async () => {
    const ctx = armar();
    const p = await ctx.servicio.procesarSubida({ buffer: m.borde, mimetype: 'image/png', originalname: 'taladro.png' }, '3', ctx.servicio.nuevoPresupuesto());
    expect(p.estado).toBe('mejorada');
    expect(p.guardada).toMatchObject({ proveedor: 'base_datos', mime: 'image/jpeg' });
    expect(ctx.almacen.guardar).toHaveBeenCalledWith(expect.objectContaining({ nombre_original: 'taladro (mejorada).jpg', mime: 'image/jpeg', carpeta: '3' }));
  });

  it('si no se puede guardar la mejorada, queda «error» y se publica la original', async () => {
    const ctx = armar();
    ctx.almacen.fallarGuardar = () => new Error('almacén caído');
    const p = await ctx.servicio.procesarSubida({ buffer: m.borde, mimetype: 'image/jpeg', originalname: 'a.jpg' }, '3', ctx.servicio.nuevoPresupuesto());
    expect(p.estado).toBe('error');
    expect(p.guardada).toBeUndefined();
  });
});

describe('MejoraFotosService.publicarTrasSubida', () => {
  it('publica la mejorada: la imagen apunta a ella y la fila guarda la original', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.borde);
    const procesado = await ctx.servicio.procesarSubida({ buffer: m.borde, mimetype: 'image/jpeg', originalname: 'a.jpg' }, '3', ctx.servicio.nuevoPresupuesto());

    const r = await ctx.servicio.publicarTrasSubida(1, original, procesado);

    expect(r.publicada!.url).toBe(procesado.guardada!.url);
    expect(ctx.repo.imagenes.get(1)!.url).toBe(procesado.guardada!.url);
    expect(ctx.repo.filas.get(1)).toMatchObject({ estado: 'mejorada', url_original: original.url, url_mejorada: procesado.guardada!.url });
    expect(ctx.almacen.eliminar).not.toHaveBeenCalled();
  });

  it('si falla la publicación, la imagen sigue en la original y se borra la clave de la mejorada', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.borde);
    const procesado = await ctx.servicio.procesarSubida({ buffer: m.borde, mimetype: 'image/jpeg', originalname: 'a.jpg' }, '3', ctx.servicio.nuevoPresupuesto());
    ctx.repo.fallarPublicar = new Error('fallo de BD');

    const r = await ctx.servicio.publicarTrasSubida(1, original, procesado);

    expect(r.publicada).toBeNull();
    expect(ctx.repo.imagenes.get(1)!.url).toBe(original.url);
    expect(ctx.repo.filas.has(1)).toBe(false);
    expect(ctx.almacen.eliminar).toHaveBeenCalledWith(procesado.guardada!.clave);
    expect(ctx.almacen.eliminar).not.toHaveBeenCalledWith(original.clave);
  });

  it('sin cambios ⇒ anota la fila y no cambia el archivo publicado', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.buena);
    const r = await ctx.servicio.publicarTrasSubida(1, original, { estado: 'sin_cambios', informe: { version: 1, acciones: [], avisos: [] } });
    expect(r).toEqual({ publicada: null, filaAlDia: true });
    expect(ctx.repo.filas.get(1)).toMatchObject({ estado: 'sin_cambios', url_original: original.url, url_mejorada: null });
  });

  it('pendiente ⇒ no escribe nada', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.buena);
    await ctx.servicio.publicarTrasSubida(1, original, { estado: 'pendiente' });
    expect(ctx.repo.registrar).not.toHaveBeenCalled();
    expect(ctx.repo.publicarMejorada).not.toHaveBeenCalled();
  });
});

describe('MejoraFotosService · por foto (usar original / usar mejorada / resumen)', () => {
  async function conMejorada() {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.borde);
    const procesado = await ctx.servicio.procesarSubida({ buffer: m.borde, mimetype: 'image/jpeg', originalname: 'a.jpg' }, '3', ctx.servicio.nuevoPresupuesto());
    await ctx.servicio.publicarTrasSubida(1, original, procesado);
    return { ...ctx, original, mejorada: procesado.guardada! };
  }

  it('usar original y usar mejorada son idempotentes y nunca borran archivos', async () => {
    const ctx = await conMejorada();

    await ctx.servicio.usarOriginal(3, 1);
    const r1 = await ctx.servicio.usarOriginal(3, 1);
    expect(ctx.repo.imagenes.get(1)!.url).toBe(ctx.original.url);
    expect(r1.mejoras[0]).toMatchObject({ estado: 'original_elegido', publicada: 'original', url_mejorada: ctx.mejorada.url });

    await ctx.servicio.usarMejorada(3, 1);
    const r2 = await ctx.servicio.usarMejorada(3, 1);
    expect(ctx.repo.imagenes.get(1)!.url).toBe(ctx.mejorada.url);
    expect(r2.mejoras[0]).toMatchObject({ estado: 'mejorada', publicada: 'mejorada', url_original: ctx.original.url });
    expect(r2.imagenes[0].url).toBe(ctx.mejorada.url);

    expect(ctx.almacen.eliminar).not.toHaveBeenCalled();
  });

  it('usar original en una foto nunca procesada anota «original_elegido» con el archivo actual', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.buena);
    const r = await ctx.servicio.usarOriginal(3, 1);
    expect(ctx.repo.filas.get(1)).toMatchObject({ estado: 'original_elegido', url_original: original.url });
    expect(r.mejoras[0]).toMatchObject({ estado: 'original_elegido', publicada: 'original' });
  });

  it('usar mejorada en una foto pendiente la mejora ahora desde la original (almacén base_datos)', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.oscura);
    const r = await ctx.servicio.usarMejorada(3, 1);
    expect(r.mejoras[0]).toMatchObject({ estado: 'mejorada', publicada: 'mejorada', url_original: original.url, acciones: ['ACLARAR'], avisos: ['MUY_OSCURA'] });
    expect(ctx.repo.imagenes.get(1)!.url).not.toBe(original.url);
  });

  it('usar mejorada en una foto que ya estaba bien la deja «sin_cambios» y publicada la original', async () => {
    const ctx = armar();
    const original = await imagenSubida(ctx, 1, m.buena);
    const r = await ctx.servicio.usarMejorada(3, 1);
    expect(r.mejoras[0]).toMatchObject({ estado: 'sin_cambios', publicada: 'original', url_mejorada: null });
    expect(ctx.repo.imagenes.get(1)!.url).toBe(original.url);
  });

  it('si la original no se puede leer (otro almacén) responde 409 sin cambiar nada', async () => {
    const ctx = armar();
    await imagenSubida(ctx, 1, m.oscura);
    ctx.almacenes.leer.mockResolvedValue(null);
    await expect(ctx.servicio.usarMejorada(3, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.repo.filas.size).toBe(0);
  });

  it('sin la tabla: resumen «no disponible» y los POST 503 con su código', async () => {
    const ctx = armar({ tabla: false });
    await imagenSubida(ctx, 1, m.buena);
    expect(await ctx.servicio.resumen(3)).toEqual({ disponible: false, activa: true, version: 1, mejoras: [] });
    const error = await ctx.servicio.usarOriginal(3, 1).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ codigo: 'MEJORA_FOTOS_NO_DISPONIBLE' });
    await expect(ctx.servicio.usarMejorada(3, 1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('foto de otro producto ⇒ 404', async () => {
    const ctx = await conMejorada();
    await expect(ctx.servicio.usarOriginal(99, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctx.servicio.usarMejorada(99, 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resumen: una foto sin fila sale «pendiente» con su archivo actual como original', async () => {
    const ctx = armar({ interruptor: false });
    const original = await imagenSubida(ctx, 1, m.buena);
    expect(await ctx.servicio.resumen(3)).toEqual({
      disponible: true, activa: false, version: 1,
      mejoras: [{ id_imagen: 1, estado: 'pendiente', publicada: 'original', url_original: original.url, url_mejorada: null, ancho_original: 10, alto_original: 10, acciones: [], avisos: [], version: null }],
    });
  });

  it('activa = tabla y interruptor', async () => {
    expect(await armar().servicio.activa()).toBe(true);
    expect(await armar({ tabla: false }).servicio.activa()).toBe(false);
    expect(await armar({ interruptor: false }).servicio.activa()).toBe(false);
  });
});

describe('nombreMejorada', () => {
  it('cambia la extensión y marca el nombre', () => {
    expect(nombreMejorada('taladro.png')).toBe('taladro (mejorada).jpg');
    expect(nombreMejorada('')).toBe('foto (mejorada).jpg');
  });
});
