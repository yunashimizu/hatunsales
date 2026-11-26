import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { almacenamientoConfig } from '../config/almacenamiento.config';
import { CloudinaryAlmacen } from '../util/storage/cloudinary.almacen';
import { DiscoAlmacen } from '../util/storage/disco.almacen';
import { AlmacenesPorNombre } from './almacenes-por-nombre';
import { AlmacenEnMemoria, RepoMejoraEnMemoria } from './mejora-fotos.doble';
import { MejoraFotosService } from './mejora-fotos.service';
import { generarMuestras, MuestrasPrueba } from './muestras-prueba';
import { ReprocesadoFotosRepository } from './reprocesado-fotos.repository';
import { EJEMPLOS_POR_CODIGO, FALLOS_SEGUIDOS_MAXIMOS, ReprocesadoFotosService } from './reprocesado-fotos.service';

jest.setTimeout(120_000);

let m: MuestrasPrueba;
beforeAll(async () => {
  m = await generarMuestras();
});

/**
 * Servicio con la mejora de verdad (mide con sharp) y dobles de la base y del almacén. La consulta de
 * fotos pendientes se imita sobre las imágenes en memoria y queda registrada en `consultas`.
 */
function armar({ tabla = true } = {}) {
  const repo = new RepoMejoraEnMemoria();
  repo.tabla = tabla;
  const almacen = new AlmacenEnMemoria();
  const config = { obtenerBooleano: jest.fn(async () => true), guardar: jest.fn(async () => undefined) };
  const imagenesRepo = { findOneById: jest.fn(), findByProducto: jest.fn(async () => []) };
  const vacio = { nombre: 'ninguno', eliminar: jest.fn(), guardar: jest.fn() };
  const almacenes = new AlmacenesPorNombre(almacen as any, almacen as any, { ...vacio, nombre: 'cloudinary' } as any, { ...vacio, nombre: 'disco' } as any);
  const mejora = new MejoraFotosService(repo as any, config as any, imagenesRepo as any, almacenes, almacen as any);

  const consultas: string[] = [];
  const bd = {
    query: jest.fn(async (sql: string, parametros: unknown[] = []) => {
      consultas.push(sql);
      if (sql.startsWith('SELECT 1 FROM productos_imagenes_mejora')) return repo.filas.has(parametros[0] as number) ? [{}] : [];
      if (sql.startsWith('WITH m AS')) {
        // Deshacer: las mejoradas publicadas vuelven a la original.
        const hechas: { id_imagen: number }[] = [];
        for (const [id, f] of repo.filas) {
          const imagen = repo.imagenes.get(id)!;
          if (f.estado !== 'mejorada' || imagen.url !== f.url_mejorada) continue;
          if (parametros[0] !== null && imagen.id_producto !== parametros[0]) continue;
          await repo.elegir(id, 'original');
          hechas.push({ id_imagen: id });
        }
        return [hechas, hechas.length];
      }
      if (!sql.includes('LIMIT $1')) return [{ fotos: String(repo.imagenes.size), pendientes: String(repo.imagenes.size - repo.filas.size) }];
      const [limite, id_producto] = parametros as number[];
      return [...repo.imagenes.values()]
        .filter((i) => !(tabla && repo.filas.has(i.id_imagen)))
        .filter((i) => id_producto === undefined || i.id_producto === id_producto)
        .sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary) || a.id_imagen - b.id_imagen)
        .slice(0, limite)
        .map((i) => ({ ...i, producto: `Producto ${i.id_producto}` }));
    }),
  };
  const lotes = new ReprocesadoFotosRepository(bd as any);
  const servicio = new ReprocesadoFotosService(lotes, mejora, almacenes);
  servicio.pausaMs = 0;
  return { servicio, mejora, repo, almacen, config, consultas, lotes, bd };
}

type Contexto = ReturnType<typeof armar>;

async function foto(ctx: Contexto, id_imagen: number, buffer: Buffer, extra: Record<string, unknown> = {}) {
  const g = await ctx.almacen.guardar({ buffer, nombre_original: 'foto.jpg', mime: 'image/jpeg', carpeta: '3' });
  ctx.repo.imagenes.set(id_imagen, {
    id_imagen, id_producto: 3, url: g.url, thumb_url: g.thumb_url, mime: g.mime, size: g.size,
    width: 10, height: 10, clave_almacen: g.clave, proveedor: g.proveedor, ...extra,
  });
  ctx.almacen.guardar.mockClear();
  return g;
}

describe('Revisión sin cambiar nada', () => {
  for (const tabla of [true, false]) {
    it(`${tabla ? 'con' : 'sin'} la tabla: cuenta y no escribe nada`, async () => {
      const ctx = armar({ tabla });
      await foto(ctx, 1, m.buena);
      await foto(ctx, 2, m.borde);
      await foto(ctx, 3, m.chica240);
      await foto(ctx, 4, m.muyBorrosa);
      const antes = JSON.stringify([...ctx.repo.imagenes.values()]);

      const arranque = await ctx.servicio.iniciarRevision();
      expect(arranque).toMatchObject({ hay_revision: true, total: 4 });
      await ctx.servicio.trabajo;

      const r = ctx.servicio.verRevision();
      expect(r).toMatchObject({ en_curso: false, completa: true, motivo_fin: 'completada', revisadas: 4, analizadas: 4, no_leidas: 0 });
      expect(r.sin_cambios).toBe(1);
      expect(r.mejorarian).toBe(3);
      expect(r.volver_a_fotografiar).toBe(2);
      expect(r.por_accion.RECORTE).toBe(1);
      expect(r.por_accion.AMPLIAR).toBe(1);
      expect(r.por_aviso.MUY_CHICA).toBe(1);
      expect(r.por_aviso.BORROSA).toBe(1);
      expect(r.ejemplos.find((e) => e.codigo === 'RECORTE')).toMatchObject({ id_imagen: 2, id_producto: 3, producto: 'Producto 3' });

      // Nada escrito: ni filas, ni archivos, ni borrados, y solo consultas SELECT.
      expect(ctx.repo.publicarMejorada).not.toHaveBeenCalled();
      expect(ctx.repo.registrar).not.toHaveBeenCalled();
      expect(ctx.repo.elegir).not.toHaveBeenCalled();
      expect(ctx.repo.eliminarFila).not.toHaveBeenCalled();
      expect(ctx.almacen.guardar).not.toHaveBeenCalled();
      expect(ctx.almacen.eliminar).not.toHaveBeenCalled();
      expect(ctx.config.guardar).not.toHaveBeenCalled();
      expect(JSON.stringify([...ctx.repo.imagenes.values()])).toBe(antes);
      for (const sql of ctx.consultas) {
        expect(sql.trim().startsWith('SELECT')).toBe(true);
        expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
        if (!tabla) expect(sql).not.toContain('productos_imagenes_mejora');
      }
    });
  }

  it('antes de la primera revisión dice que no hay', () => {
    expect(armar().servicio.verRevision()).toMatchObject({ hay_revision: false, en_curso: false, revisadas: 0, ejemplos: [] });
  });

  it('dos pulsaciones no lanzan dos pasadas', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.buena);
    const primera = ctx.servicio.iniciarRevision();
    await expect(ctx.servicio.iniciarRevision()).rejects.toBeInstanceOf(ConflictException);
    await primera;
    await ctx.servicio.trabajo;
    await expect(ctx.servicio.iniciarRevision()).resolves.toBeDefined();
    await ctx.servicio.trabajo;
  });

  it('respeta el límite, va de a una y se detiene entre fotos', async () => {
    const ctx = armar();
    for (let i = 1; i <= 5; i++) await foto(ctx, i, m.buena);
    await ctx.servicio.iniciarRevision(3);
    await ctx.servicio.trabajo;
    expect(ctx.servicio.verRevision()).toMatchObject({ total: 3, revisadas: 3 });

    let enCurso = 0;
    let maximo = 0;
    const revisar = ctx.mejora.revisar.bind(ctx.mejora);
    jest.spyOn(ctx.mejora, 'revisar').mockImplementation(async (buffer) => {
      maximo = Math.max(maximo, ++enCurso);
      const salida = await revisar(buffer);
      enCurso--;
      ctx.servicio.detener();
      return salida;
    });
    await ctx.servicio.iniciarRevision();
    await ctx.servicio.trabajo;
    expect(maximo).toBe(1);
    expect(ctx.servicio.verRevision()).toMatchObject({ motivo_fin: 'detenida', completa: false, revisadas: 1, total: 5, en_curso: false });
    expect(ctx.servicio.detener()).toEqual({ detenido: false });
  });

  it('una foto que no se puede leer se cuenta aparte y la pasada sigue', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.buena, { url: '/uploads/vieja.jpg', clave_almacen: null, proveedor: null });
    await foto(ctx, 2, m.borde, { size: 50 * 1024 * 1024 });
    await foto(ctx, 3, Buffer.from('esto no es una imagen'));
    await foto(ctx, 4, m.transparente);
    await ctx.servicio.iniciarRevision();
    await ctx.servicio.trabajo;
    const r = ctx.servicio.verRevision();
    expect(r).toMatchObject({ revisadas: 4, no_leidas: 3, analizadas: 1, omitidas: 1, completa: true });
    expect(r.ejemplos.filter((e) => e.codigo === 'NO_LEIDA')).toHaveLength(3);
    expect(r.ultimo_error).toBeTruthy();
  });

  it(`se detiene sola tras ${FALLOS_SEGUIDOS_MAXIMOS} fallos seguidos`, async () => {
    const ctx = armar();
    for (let i = 1; i <= 15; i++) await foto(ctx, i, m.buena);
    jest.spyOn(ctx.mejora, 'revisar').mockRejectedValue(new Error('sin memoria'));
    await ctx.servicio.iniciarRevision();
    await ctx.servicio.trabajo;
    expect(ctx.servicio.verRevision()).toMatchObject({ motivo_fin: 'fallos', revisadas: FALLOS_SEGUIDOS_MAXIMOS, ultimo_error: 'sin memoria' });
  });

  it(`guarda como mucho ${EJEMPLOS_POR_CODIGO} ejemplos por motivo`, async () => {
    const ctx = armar();
    for (let i = 1; i <= EJEMPLOS_POR_CODIGO + 3; i++) await foto(ctx, i, m.buena);
    await ctx.servicio.iniciarRevision();
    await ctx.servicio.trabajo;
    const r = ctx.servicio.verRevision();
    expect(r.sin_cambios).toBe(EJEMPLOS_POR_CODIGO + 3);
    expect(r.ejemplos).toHaveLength(EJEMPLOS_POR_CODIGO);
  });

  it('si la consulta falla no deja la pasada tomada', async () => {
    const ctx = armar();
    ctx.bd.query.mockRejectedValueOnce(new Error('base caída'));
    await expect(ctx.servicio.iniciarRevision()).rejects.toThrow('base caída');
    expect((await ctx.servicio.estado()).lote.en_curso).toBe(false);
  });
});

describe('Mejorar por tandas', () => {
  it('sin la tabla responde 503 en palabras claras y no toca nada; la pasada no queda tomada', async () => {
    const ctx = armar({ tabla: false });
    await foto(ctx, 1, m.borde);
    await expect(ctx.servicio.iniciarMejora()).rejects.toThrow(ServiceUnavailableException);
    await expect(ctx.servicio.iniciarMejora()).rejects.toThrow('sql/fase23_mejora_fotos.sql');
    await expect(ctx.servicio.deshacer()).rejects.toThrow(ServiceUnavailableException);
    expect(ctx.almacen.guardar).not.toHaveBeenCalled();
    expect((await ctx.servicio.estado()).lote).toMatchObject({ en_curso: false, tipo: null });
  });

  it('mejora de a una, respeta el límite y relanzarla sigue con las que faltan', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.borde, { is_primary: false });
    await foto(ctx, 2, m.buena, { is_primary: true });
    await foto(ctx, 3, m.oscura);

    const arranque = await ctx.servicio.iniciarMejora(2);
    expect(arranque.lote).toMatchObject({ en_curso: true, tipo: 'mejora', total: 2 });
    await ctx.servicio.trabajo;
    let lote = (await ctx.servicio.estado()).lote;
    // La principal primero, después por id.
    expect(lote).toMatchObject({ en_curso: false, procesadas: 2, mejoradas: 1, sin_cambios: 1, errores: 0, motivo_fin: 'completada' });
    expect([...ctx.repo.filas.keys()].sort()).toEqual([1, 2]);
    expect(ctx.repo.filas.get(1)!.estado).toBe('mejorada');
    expect(ctx.repo.imagenes.get(1)!.url).toBe(ctx.repo.filas.get(1)!.url_mejorada);
    expect(ctx.repo.imagenes.get(2)!.url).toBe(ctx.repo.filas.get(2)!.url_original);

    ctx.repo.publicarMejorada.mockClear();
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    lote = (await ctx.servicio.estado()).lote;
    expect(lote).toMatchObject({ total: 1, mejoradas: 1 });
    expect(ctx.repo.publicarMejorada).toHaveBeenCalledTimes(1);
    expect(ctx.repo.publicarMejorada.mock.calls[0][0]).toBe(3);

    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect((await ctx.servicio.estado()).lote).toMatchObject({ total: 0, procesadas: 0, motivo_fin: 'completada' });
  });

  it('nunca pisa una decisión tomada mientras corría (original elegida)', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.borde);
    await foto(ctx, 2, m.borde);
    const urlAntes = ctx.repo.imagenes.get(2)!.url;
    const mejorar = ctx.mejora.mejorarExistente.bind(ctx.mejora);
    jest.spyOn(ctx.mejora, 'mejorarExistente').mockImplementation(async (...args) => {
      const salida = await mejorar(...args);
      // Mientras tanto alguien pulsa «Usar la original» en la foto 2.
      await ctx.repo.registrar(2, 'original_elegido', 1, { proveedor: 'base_datos', url: urlAntes, clave: '1', thumb_url: null, mime: null, size: null, ancho: null, alto: null }, {});
      return salida;
    });
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect(ctx.repo.filas.get(2)!.estado).toBe('original_elegido');
    expect(ctx.repo.imagenes.get(2)!.url).toBe(urlAntes);
    expect((await ctx.servicio.estado()).lote).toMatchObject({ mejoradas: 1, saltadas: 1 });
  });

  it('se detiene entre fotos y no lanza otra pasada mientras corre', async () => {
    const ctx = armar();
    for (let i = 1; i <= 4; i++) await foto(ctx, i, m.buena);
    const mejorar = ctx.mejora.mejorarExistente.bind(ctx.mejora);
    jest.spyOn(ctx.mejora, 'mejorarExistente').mockImplementation(async (...args) => {
      await expect(ctx.servicio.iniciarMejora()).rejects.toThrow(ConflictException);
      await expect(ctx.servicio.iniciarRevision()).rejects.toThrow(ConflictException);
      await expect(ctx.servicio.deshacer()).rejects.toThrow(ConflictException);
      ctx.servicio.detener();
      return mejorar(...args);
    });
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect((await ctx.servicio.estado()).lote).toMatchObject({ procesadas: 1, total: 4, motivo_fin: 'detenida', en_curso: false });
    expect(ctx.repo.filas.size).toBe(1);
  });

  it('un error se anota en esa foto y la tanda sigue; una ilegible queda omitida', async () => {
    const ctx = armar();
    await foto(ctx, 1, Buffer.from('roto'));
    await foto(ctx, 2, m.borde, { url: '/uploads/vieja.jpg', clave_almacen: null, proveedor: null });
    await foto(ctx, 3, m.oscura);
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect((await ctx.servicio.estado()).lote).toMatchObject({ procesadas: 3, errores: 1, omitidas: 1, mejoradas: 1 });
    expect(ctx.repo.filas.get(1)!.estado).toBe('error');
    expect(ctx.repo.filas.get(2)).toMatchObject({ estado: 'omitida', informe: { motivo: 'no_legible' } });
    expect(ctx.repo.filas.get(3)!.estado).toBe('mejorada');
  });

  it('si el almacén falla al guardar, la foto queda como estaba, anotada con error', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.borde);
    const antes = ctx.repo.imagenes.get(1)!.url;
    ctx.almacen.fallarGuardar = () => new Error('disco lleno');
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect(ctx.repo.imagenes.get(1)!.url).toBe(antes);
    expect(ctx.repo.filas.get(1)!.estado).toBe('error');
    expect((await ctx.servicio.estado()).lote).toMatchObject({ errores: 1, ultimo_error: 'disco lleno' });
  });

  it('por producto: solo las de ese producto', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.borde, { id_producto: 3 });
    await foto(ctx, 2, m.oscura, { id_producto: 4 });
    await ctx.servicio.iniciarMejora(undefined, 4);
    await ctx.servicio.trabajo;
    expect([...ctx.repo.filas.keys()]).toEqual([2]);
  });

  it('deshacer vuelve a la original sin borrar archivos, y la tanda no las vuelve a tocar', async () => {
    const ctx = armar();
    await foto(ctx, 1, m.borde);
    await foto(ctx, 2, m.oscura);
    const originales = [1, 2].map((i) => ctx.repo.imagenes.get(i)!.url);
    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    ctx.almacen.eliminar.mockClear();

    await expect(ctx.servicio.deshacer()).resolves.toEqual({ revertidas: 2 });
    expect([1, 2].map((i) => ctx.repo.imagenes.get(i)!.url)).toEqual(originales);
    expect(ctx.almacen.eliminar).not.toHaveBeenCalled();
    expect(ctx.consultas.some((q) => /DELETE/.test(q))).toBe(false);
    await expect(ctx.servicio.deshacer()).resolves.toEqual({ revertidas: 0 });

    await ctx.servicio.iniciarMejora();
    await ctx.servicio.trabajo;
    expect((await ctx.servicio.estado()).lote.total).toBe(0);
  });
});

describe('Leer originales de otros almacenes', () => {
  it('disco: lee dentro de su carpeta; nunca fuera; null si ya no está', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'fotos-'));
    const antes = almacenamientoConfig.disco.ruta;
    almacenamientoConfig.disco.ruta = raiz;
    try {
      await writeFile(join(raiz, 'a.jpg'), 'foto');
      const disco = new DiscoAlmacen();
      await expect(disco.leerOriginal({ clave: 'a.jpg', url: '/uploads/a.jpg' })).resolves.toEqual({ buffer: Buffer.from('foto'), mime: 'image/jpeg' });
      await expect(disco.leerOriginal({ clave: 'no.jpg', url: '' })).resolves.toBeNull();
      await expect(disco.leerOriginal({ clave: '../../etc/passwd', url: '' })).resolves.toBeNull();
      await expect(disco.leerOriginal({ clave: '', url: '' })).resolves.toBeNull();
    } finally {
      almacenamientoConfig.disco.ruta = antes;
      await rm(raiz, { recursive: true, force: true });
    }
  });

  it('cloudinary: pide el archivo subido, sin transformaciones, y solo a su propia cuenta', async () => {
    const antes = almacenamientoConfig.cloudinary.cloud_name;
    almacenamientoConfig.cloudinary.cloud_name = 'demo';
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: Buffer.from('foto'), headers: { 'content-type': 'image/jpeg' } } as any);
    try {
      const nube = new CloudinaryAlmacen();
      const url = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_1200,c_limit/hatunsales/3/abc.jpg';
      await expect(nube.leerOriginal({ clave: 'hatunsales/3/abc', url })).resolves.toEqual({ buffer: Buffer.from('foto'), mime: 'image/jpeg' });
      expect(get).toHaveBeenCalledWith('https://res.cloudinary.com/demo/image/upload/hatunsales/3/abc.jpg', expect.objectContaining({ timeout: 20_000, responseType: 'arraybuffer' }));
      get.mockClear();
      await expect(nube.leerOriginal({ clave: 'x', url: 'https://otro.example/x.jpg' })).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
      get.mockRejectedValueOnce({ response: { status: 404 } });
      await expect(nube.leerOriginal({ clave: 'hatunsales/3/abc', url })).resolves.toBeNull();
      get.mockRejectedValueOnce(new Error('timeout'));
      await expect(nube.leerOriginal({ clave: 'hatunsales/3/abc', url })).rejects.toThrow('timeout');
    } finally {
      get.mockRestore();
      almacenamientoConfig.cloudinary.cloud_name = antes;
    }
  });
});

describe('Consultas', () => {
  it('deshacer es una sola sentencia que no borra y solo toca las publicadas como mejoradas', async () => {
    const query = jest.fn(async (_sql: string, _p?: unknown[]) => [[{ id_imagen: 1 }], 1]);
    await expect(new ReprocesadoFotosRepository({ query } as any).deshacer(5)).resolves.toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, p] = query.mock.calls[0];
    expect(p).toEqual([5]);
    expect(sql).toMatch(/x\.estado = 'mejorada' AND pi\.url = x\.url_mejorada/);
    expect(sql).toMatch(/SET estado = 'original_elegido'/);
    expect(sql).not.toMatch(/DELETE/);
  });

  it('totales sin la tabla no la nombran y todo queda pendiente', async () => {
    const query = jest.fn(async (_sql: string) => [{ fotos: '7', pendientes: '7', chicas: '2' }]);
    await expect(new ReprocesadoFotosRepository({ query } as any).totales(false)).resolves.toMatchObject({ fotos: 7, pendientes: 7, chicas: 2, mejoradas: 0, bytes_mejoradas: 0 });
    expect(query.mock.calls[0][0]).not.toContain('productos_imagenes_mejora');
  });
});
