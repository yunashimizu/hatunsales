import { createHash } from 'crypto';
import { DocumentoCpeInvalidoError } from '../nucleo/errores-nucleo';
import { verificarFirmaXml } from '../nucleo/firma/firmador-xml';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import { descendientes, parsearXml } from '../nucleo/xml/lector-xml';
import { leerXmlDeZip } from '../nucleo/zip/paquete-zip';
import { GreInvalidaError, PreparadorGre } from './preparador-gre';
import { greOtrosPrivado, greTrasladoPrivado, greVentaPublica, HOY_GRE_PRUEBA } from './pruebas/documentos-gre-prueba-spec';

describe('PreparadorGre', () => {
  const certificado = generarCertificadoPrueba();
  const material = materialDePrueba(certificado);
  const preparador = new PreparadorGre();
  const opciones = { hoy: HOY_GRE_PRUEBA, ahora: new Date() };

  it.each([
    ['venta pública', greVentaPublica()],
    ['traslado privado', greTrasladoPrivado()],
    ['otros con caracteres especiales', greOtrosPrivado()],
  ])('%s: valida, firma (verificable), empaqueta y calcula el SHA-256 hex del ZIP', (_nombre, documento) => {
    const preparada = preparador.preparar(documento, material, opciones);

    expect(preparada.nombreBase).toMatch(/^20610206337-09-T001-0000000\d$/);
    expect(verificarFirmaXml(preparada.xmlFirmado, certificado.certificatePem)).toBe(true);
    expect(descendientes(parsearXml(preparada.xmlFirmado), 'Signature').filter((e) => e.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#')).toHaveLength(1);
    expect(preparada.xmlFirmado).toContain('<ds:Signature Id="SignatureSP"');
    expect(preparada.xml).not.toContain('ds:SignatureValue');
    expect(preparada.digestValue).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // ZIP con un solo XML del mismo nombre, idéntico al firmado.
    const contenido = leerXmlDeZip(preparada.zip);
    expect(contenido).toEqual({ nombre: `${preparada.nombreBase}.xml`, xml: preparada.xmlFirmado });
    expect(preparada.zipBase64).toBe(preparada.zip.toString('base64'));
    expect(preparada.sha256).toBe(createHash('sha256').update(preparada.zip).digest('hex'));
    expect(preparada.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('devuelve las advertencias y una copia del documento (cambiar el original no altera lo preparado)', () => {
    const documento = greVentaPublica({ documentosRelacionados: [] });
    const preparada = preparador.preparar(documento, material, opciones);
    expect(preparada.advertencias.join(' ')).toContain('conviene relacionar la factura o boleta');
    documento.items[0].descripcion = 'OTRA COSA';
    expect(preparada.documento.items[0].descripcion).toBe('CEMENTO SOL TIPO I BOLSA 42.5 KG');
    expect(preparada.documento).not.toBe(documento);
  });

  it('con errores de validación lanza GreInvalidaError antes de firmar', () => {
    const firmador = { firmar: jest.fn() };
    const conDoble = new PreparadorGre(undefined, firmador as never);
    let capturado: unknown;
    try {
      conDoble.preparar(greVentaPublica({ envio: { motivo: '02' }, serie: 'X1' }), material, opciones);
    } catch (error) {
      capturado = error;
    }
    expect(capturado).toBeInstanceOf(GreInvalidaError);
    expect(capturado).toBeInstanceOf(DocumentoCpeInvalidoError);
    const error = capturado as GreInvalidaError;
    expect(error.codigo).toBe('FISCAL_DOCUMENTO_INVALIDO');
    expect(error.errores.length).toBeGreaterThanOrEqual(2);
    expect(error.message).toContain('La guía de remisión no pasa las validaciones previas al envío');
    expect(firmador.firmar).not.toHaveBeenCalled();
  });

  it('no firma con un certificado vencido', () => {
    const vencido = generarCertificadoPrueba({ desde: new Date('2020-01-01'), hasta: new Date('2021-01-01') });
    expect(() => preparador.preparar(greVentaPublica(), materialDePrueba(vencido), opciones)).toThrow();
  });
});
