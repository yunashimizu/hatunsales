import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { crearMiddlewareCompresion, debeComprimir, UMBRAL_COMPRESION_BYTES } from './compresion';

/** Respuesta falsa con solo las cabeceras que mira el filtro. */
function respuesta(cabeceras: Record<string, string>): Response {
  const porNombre = new Map(Object.entries(cabeceras).map(([clave, valor]) => [clave.toLowerCase(), valor]));
  return { getHeader: (nombre: string) => porNombre.get(nombre.toLowerCase()) } as unknown as Response;
}

const peticion = { headers: {} } as Request;
const JSON_GRANDE = { datos: Array.from({ length: 200 }, (_, i) => ({ id: i, nombre: `Producto ${i}`, precio: 10.5 })) };
const TEXTO_GRANDE = 'x'.repeat(UMBRAL_COMPRESION_BYTES * 4);

describe('debeComprimir (filtro de la compresión)', () => {
  it('comprime JSON y texto', () => {
    expect(debeComprimir(peticion, respuesta({ 'Content-Type': 'application/json; charset=utf-8' }))).toBe(true);
    expect(debeComprimir(peticion, respuesta({ 'Content-Type': 'text/html; charset=utf-8' }))).toBe(true);
  });

  it.each([
    'image/png',
    'image/svg+xml',
    'application/zip',
    'application/pdf',
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ])('no comprime %s', (tipo) => {
    expect(debeComprimir(peticion, respuesta({ 'Content-Type': tipo }))).toBe(false);
  });

  it('no comprime ninguna descarga attachment, aunque sea XML o JSON', () => {
    const xml = { 'Content-Type': 'application/xml', 'Content-Disposition': 'attachment; filename="R-20610206337-01-F001-1.xml"' };
    expect(debeComprimir(peticion, respuesta(xml))).toBe(false);
    expect(debeComprimir(peticion, respuesta({ 'Content-Type': 'application/json', 'Content-Disposition': 'ATTACHMENT' }))).toBe(false);
  });

  it('sin Content-Type no comprime (filtro estándar)', () => {
    expect(debeComprimir(peticion, respuesta({}))).toBe(false);
  });
});

describe('crearMiddlewareCompresion (con Express real)', () => {
  const app = express();
  app.use(crearMiddlewareCompresion());
  app.get('/json', (_req, res) => {
    res.json(JSON_GRANDE);
  });
  app.get('/chico', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/descarga', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="cdr.xml"');
    res.type('application/xml').send(`<cdr>${TEXTO_GRANDE}</cdr>`);
  });
  app.get('/zip', (_req, res) => {
    res.type('application/zip').send(Buffer.alloc(UMBRAL_COMPRESION_BYTES * 4));
  });
  app.get('/sin-transformar', (_req, res) => {
    res.setHeader('Cache-Control', 'no-transform');
    res.json(JSON_GRANDE);
  });

  it('un JSON grande sale comprimido con gzip y con Vary: Accept-Encoding', async () => {
    const r = await request(app).get('/json').set('Accept-Encoding', 'gzip');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(r.body).toEqual(JSON_GRANDE);
  });

  it('sin Accept-Encoding sale sin comprimir', async () => {
    const r = await request(app).get('/json').set('Accept-Encoding', 'identity');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body).toEqual(JSON_GRANDE);
  });

  it('por debajo del umbral no comprime', async () => {
    const r = await request(app).get('/chico').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
  });

  it('una descarga attachment sale intacta, con su Content-Length', async () => {
    const r = await request(app).get('/descarga').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(`<cdr>${TEXTO_GRANDE}</cdr>`));
  });

  it('un zip no se vuelve a comprimir', async () => {
    const r = await request(app).get('/zip').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
  });

  it('respeta Cache-Control: no-transform', async () => {
    const r = await request(app).get('/sin-transformar').set('Accept-Encoding', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
  });
});
