import AdmZip from 'adm-zip';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { RelojFiscal } from '../config/reloj-fiscal';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import { verificarFirmaXml } from '../nucleo/firma/firmador-xml';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import {
  generarCertificadoPrueba,
  materialDePrueba,
} from '../nucleo/pruebas/certificados-prueba-spec';
import { facturaPrueba } from '../nucleo/pruebas/documentos-prueba-spec';
import {
  cdrPrueba,
  respuestaSendBill,
} from '../nucleo/pruebas/respuestas-sunat-prueba-spec';
import { FabricaClienteSoapSunat } from '../nucleo/soap/sunat-soap-client';
import { ErrorTransporteSoap } from '../nucleo/soap/transporte-soap';
import { EnvioBetaRepository } from './envio-beta.repository';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';

class RelojPrueba extends RelojFiscal {
  ahora() {
    return new Date('2026-10-13T15:00:00Z');
  }
}

describe('SunatEmisionBetaService: circuito completo sin red', () => {
  const certificado = generarCertificadoPrueba({
    desde: new Date('2026-10-12'),
    hasta: new Date('2027-10-13'),
  });
  const material = materialDePrueba(certificado);
  const cdr = cdrPrueba({ codigo: '0', descripcion: 'Aceptada' });
  let repo: {
    registrarPreparado: jest.Mock;
    completar: jest.Mock;
    tomarReenvio: jest.Mock;
  };
  let transporte: { enviar: jest.Mock };
  let preparador: PreparadorEnvioCpe;
  let servicio: SunatEmisionBetaService;

  beforeEach(() => {
    repo = {
      registrarPreparado: jest.fn().mockResolvedValue(42),
      completar: jest.fn().mockResolvedValue(undefined),
      tomarReenvio: jest.fn(),
    };
    transporte = {
      enviar: jest
        .fn()
        .mockResolvedValue({ estadoHttp: 200, cuerpo: respuestaSendBill(cdr) }),
    };
    preparador = new PreparadorEnvioCpe();
    servicio = new SunatEmisionBetaService(
      repo as unknown as EnvioBetaRepository,
      preparador,
      new FabricaClienteSoapSunat({ transporte }),
      new ClasificadorRespuestaSunat(),
      new RelojPrueba(),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('firma el XML real, guarda el ZIP antes de enviar y conserva el CDR sin recalcular los importes', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      SUNAT_FISCAL_ENVIRONMENT: 'produccion',
      SUNAT_PASSWORD: 'CLAVE-PRODUCCION-NO-USAR',
    });
    transporte.enviar.mockImplementation(async () => {
      expect(repo.registrarPreparado).toHaveBeenCalledTimes(1);
      return { estadoHttp: 200, cuerpo: respuestaSendBill(cdr) };
    });
    const resultado = await servicio.emitir(facturaPrueba(), material, 1);
    const preparado = repo.registrarPreparado.mock.calls[0][1];
    const zip = new AdmZip(preparado.zip.zip);
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      `${preparado.nombreBase}.xml`,
    ]);
    const xml = zip.readAsText(zip.getEntries()[0]);
    expect(xml).toBe(preparado.xmlFirmado);
    expect(verificarFirmaXml(xml, certificado.certificatePem)).toBe(true);
    expect(xml).toContain('>10.00</cbc:PayableAmount>');
    expect(transporte.enviar.mock.calls[0][0].url).toBe(
      'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
    );
    expect(transporte.enviar.mock.calls[0][0].soapAction).toBe(
      '"urn:sendBill"',
    );
    expect(transporte.enviar.mock.calls[0][0].cuerpo).not.toContain(
      'CLAVE-PRODUCCION-NO-USAR',
    );
    expect(resultado).toMatchObject({
      ambiente: 'beta',
      id_envio: 42,
      aceptado: true,
      codigo: '0',
      estado: 'ACEPTADO',
    });
    expect(resultado.archivos).toEqual([
      'xml_original',
      'xml_firmado',
      'zip',
      'cdr_xml',
      'cdr_zip',
    ]);
    expect(repo.completar.mock.calls[0][2]).toMatchObject({
      cdrXml: cdr,
      cdrZip: expect.any(Buffer),
    });
    expect(JSON.stringify(resultado)).not.toContain('PRIVATE KEY');
  });

  it('rechaza un RUC distinto al del certificado antes de persistir o enviar', async () => {
    await expect(
      servicio.emitir(facturaPrueba(), { ...material, ruc: '20131312955' }, 1),
    ).rejects.toMatchObject({ codigo: 'FISCAL_CERT_RUC_NO_COINCIDE' });
    expect(repo.registrarPreparado).not.toHaveBeenCalled();
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('no envía si los totales del XML no cuadran o si falla el guardado previo', async () => {
    const doc = facturaPrueba();
    doc.totales.total = 999;
    await expect(servicio.emitir(doc, material, 1)).rejects.toMatchObject({
      codigo: 'FISCAL_VALIDACION_CPE',
    });
    expect(transporte.enviar).not.toHaveBeenCalled();
    repo.registrarPreparado.mockRejectedValueOnce(
      new Error('BD no disponible'),
    );
    await expect(servicio.emitir(facturaPrueba(), material, 1)).rejects.toThrow(
      'BD no disponible',
    );
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('un timeout queda pendiente y no dispara reintentos automáticos del envío', async () => {
    transporte.enviar.mockRejectedValueOnce(
      new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'),
    );
    const resultado = await servicio.emitir(facturaPrueba(), material, null);
    expect(resultado).toMatchObject({
      aceptado: false,
      estado: 'PENDIENTE_REENVIO',
      codigo: 'ETIMEDOUT',
    });
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(resultado.archivos).toEqual(['xml_original', 'xml_firmado', 'zip']);
  });

  it('no presenta un CDR de rechazo como aceptado', async () => {
    transporte.enviar.mockResolvedValueOnce({
      estadoHttp: 200,
      cuerpo: respuestaSendBill(
        cdrPrueba({ codigo: '2335', descripcion: 'Documento rechazado' }),
      ),
    });
    expect(
      await servicio.emitir(facturaPrueba(), material, null),
    ).toMatchObject({ aceptado: false, codigo: '2335', estado: 'RECHAZADO' });
  });

  it('identifica el envío si SUNAT responde pero la BD falla al guardar el CDR', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    repo.completar.mockRejectedValueOnce(new Error('BD no disponible'));
    const error = await servicio
      .emitir(facturaPrueba(), material, null)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({
      id_envio: 42,
      ambiente: 'beta',
      codigo_sunat: '0',
    });
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
  });

  it('reenvía los mismos bytes del ZIP sin volver a generar XML ni firma', async () => {
    const preparar = jest.spyOn(preparador, 'prepararComprobante');
    transporte.enviar.mockRejectedValueOnce(
      new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'),
    );
    await servicio.emitir(facturaPrueba(), material, 1);
    const preparado = repo.registrarPreparado.mock.calls[0][1];
    repo.tomarReenvio.mockResolvedValueOnce({
      id_envio: 42,
      nombre_archivo: preparado.zip.nombreZip,
      respuesta_json: {
        documento: facturaPrueba(),
        digest: preparado.digestValue,
        cadena_qr: preparado.cadenaQr,
      },
      zip: preparado.zip.zip,
    });
    const resultado = await servicio.reintentar(42);
    expect(resultado.aceptado).toBe(true);
    expect(preparar).toHaveBeenCalledTimes(1);
    expect(repo.registrarPreparado).toHaveBeenCalledTimes(1);
    const contenido = (body: string) =>
      /<contentFile>([^<]+)<\/contentFile>/.exec(body)?.[1];
    expect(contenido(transporte.enviar.mock.calls[0][0].cuerpo)).toBe(
      preparado.zip.base64,
    );
    expect(contenido(transporte.enviar.mock.calls[1][0].cuerpo)).toBe(
      contenido(transporte.enviar.mock.calls[0][0].cuerpo),
    );
  });

  it('bloquea el reenvío de un registro que no está pendiente o está reservado por otra petición', async () => {
    repo.tomarReenvio.mockResolvedValueOnce(null);
    await expect(servicio.reintentar(42)).rejects.toMatchObject({
      codigo: 'FISCAL_REENVIO_NO_PERMITIDO',
    });
    expect(transporte.enviar).not.toHaveBeenCalled();
  });
});
