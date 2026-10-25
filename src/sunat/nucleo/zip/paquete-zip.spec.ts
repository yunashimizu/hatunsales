import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { PaqueteZipError } from '../errores-nucleo';
import { empaquetarZip, esNombreBaseSunat, leerXmlDeZip } from './paquete-zip';

const XML = '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:Note xmlns:cbc="x">ÑANDÚ</cbc:Note></Invoice>';

describe('empaquetarZip', () => {
  it('crea un ZIP con una sola entrada nombreBase.xml (UTF-8) y devuelve buffer, base64 y SHA-256 hex', () => {
    const paquete = empaquetarZip('20610206337-01-FFF1-00000007', XML);
    expect(paquete.nombreZip).toBe('20610206337-01-FFF1-00000007.zip');
    expect(paquete.nombreXml).toBe('20610206337-01-FFF1-00000007.xml');
    expect(paquete.base64).toBe(paquete.zip.toString('base64'));
    expect(paquete.sha256).toBe(createHash('sha256').update(paquete.zip).digest('hex'));
    expect(paquete.sha256).toMatch(/^[0-9a-f]{64}$/);

    const entradas = new AdmZip(paquete.zip).getEntries();
    expect(entradas.map((e) => e.entryName)).toEqual(['20610206337-01-FFF1-00000007.xml']);
    expect(entradas[0].getData().toString('utf8')).toBe(XML);
  });

  it('sirve para resúmenes, bajas y guías', () => {
    const rc = '<SummaryDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1"/>';
    expect(empaquetarZip('20610206337-RC-20261013-00001', rc).nombreZip).toBe('20610206337-RC-20261013-00001.zip');
    expect(empaquetarZip('20610206337-RA-20261013-2', '<VoidedDocuments xmlns="v"/>').nombreXml).toBe('20610206337-RA-20261013-2.xml');
    expect(empaquetarZip('20610206337-09-T001-00000001', '<DespatchAdvice xmlns="d"/>').nombreZip).toBe('20610206337-09-T001-00000001.zip');
  });

  it('rechaza nombres fuera de la convención de SUNAT y contenidos que no son XML de SUNAT', () => {
    expect(() => empaquetarZip('factura.zip', XML)).toThrow(PaqueteZipError);
    expect(() => empaquetarZip('20610206337-01-fff1-00000007', XML)).toThrow('convención de SUNAT');
    expect(() => empaquetarZip('20610206337-01-FFF1-00000007', '<html></html>')).toThrow('no es un documento XML de SUNAT');
    expect(esNombreBaseSunat('20610206337-07-FC01-1')).toBe(true);
    expect(esNombreBaseSunat('20610206337-RC-2026101-1')).toBe(false);
  });
});

describe('leerXmlDeZip', () => {
  it('lee la constancia R-*.xml desde un Buffer o desde base64', () => {
    const zip = new AdmZip();
    zip.addFile('R-20610206337-01-FFF1-00000007.xml', Buffer.from('<ApplicationResponse/>', 'utf8'));
    const buffer = zip.toBuffer();
    expect(leerXmlDeZip(buffer)).toEqual({ nombre: 'R-20610206337-01-FFF1-00000007.xml', xml: '<ApplicationResponse/>' });
    expect(leerXmlDeZip(buffer.toString('base64'))?.xml).toBe('<ApplicationResponse/>');
  });

  it('salta la carpeta dummy/ que SUNAT agrega al ZIP de la constancia', () => {
    const zip = new AdmZip();
    zip.addFile('dummy/', Buffer.alloc(0));
    zip.addFile('R-20614736420-03-BB01-00000002.xml', Buffer.from('<ar:ApplicationResponse xmlns:ar="a"/>', 'utf8'));
    expect(leerXmlDeZip(zip.toBuffer())).toEqual({ nombre: 'R-20614736420-03-BB01-00000002.xml', xml: '<ar:ApplicationResponse xmlns:ar="a"/>' });
  });

  it('respeta la codificación declarada (UTF-8 por omisión, ISO-8859-1 si lo dice) y quita el BOM', () => {
    const utf8 = '<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse>La Nota de Crédito ÑANDÚ</ApplicationResponse>';
    const latin1 = '<?xml version="1.0" encoding="ISO-8859-1" standalone="no" ?><ApplicationResponse>La Nota de Crédito ÑANDÚ</ApplicationResponse>';
    const zip = (contenido: Buffer) => {
      const archivo = new AdmZip();
      archivo.addFile('R-20610206337-07-FC01-00000001.xml', contenido);
      return archivo.toBuffer();
    };
    expect(leerXmlDeZip(zip(Buffer.from(utf8, 'utf8')))?.xml).toBe(utf8);
    expect(leerXmlDeZip(zip(Buffer.from(latin1, 'latin1')))?.xml).toBe(latin1);
    expect(leerXmlDeZip(zip(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8, 'utf8')])))?.xml).toBe(utf8);
  });

  it('devuelve null si el ZIP es ilegible, está vacío o no trae XML', () => {
    expect(leerXmlDeZip('no-es-base64-de-un-zip')).toBeNull();
    expect(leerXmlDeZip(Buffer.alloc(0))).toBeNull();
    const zip = new AdmZip();
    zip.addFile('leame.txt', Buffer.from('hola'));
    expect(leerXmlDeZip(zip.toBuffer())).toBeNull();
  });
});
