import AdmZip from 'adm-zip';
import { CdrExtractorUtil } from './cdr-extractor.util';

function construirRespuestaSendBill(cdrXml: string): string {
  const zip = new AdmZip();
  zip.addFile('R-20123456789-01-F001-1.xml', Buffer.from(cdrXml, 'utf8'));
  const base64 = zip.toBuffer().toString('base64');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
  <soap-env:Body>
    <br:sendBillResponse xmlns:br="http://service.sunat.gob.pe">
      <applicationResponse>${base64}</applicationResponse>
    </br:sendBillResponse>
  </soap-env:Body>
</soap-env:Envelope>`;
}

describe('CdrExtractorUtil', () => {
  const cdrXmlOriginal = '<ApplicationResponse><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>Aceptada</cbc:Description></ApplicationResponse>';

  it('descomprime y decodifica el CDR real embebido en applicationResponse', () => {
    const respuestaSoap = construirRespuestaSendBill(cdrXmlOriginal);

    const cdrXml = new CdrExtractorUtil().extraerCdrXml(respuestaSoap);

    expect(cdrXml).toContain('<cbc:ResponseCode>0</cbc:ResponseCode>');
    expect(cdrXml).toContain('Aceptada');
  });

  it('extrae ticket de una respuesta sendSummary', () => {
    const xml = `<soap-env:Envelope><soap-env:Body><ns2:sendSummaryResponse><ticket>1234567890</ticket></ns2:sendSummaryResponse></soap-env:Body></soap-env:Envelope>`;

    expect(new CdrExtractorUtil().extraerTicket(xml)).toBe('1234567890');
  });

  it('descomprime el content de una respuesta getStatus ya resuelta', () => {
    const respuestaSoap = construirRespuestaSendBill(cdrXmlOriginal).replace(/applicationResponse/g, 'content');

    const cdrXml = new CdrExtractorUtil().extraerCdrXml(respuestaSoap);

    expect(cdrXml).toContain('Aceptada');
  });

  it('detecta un SOAP Fault y extrae faultcode/faultstring', () => {
    const xml = `<?xml version="1.0"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
  <soap-env:Body>
    <soap-env:Fault>
      <faultcode>soap-env:Client.0154</faultcode>
      <faultstring>El usuario o clave son incorrectos.</faultstring>
    </soap-env:Fault>
  </soap-env:Body>
</soap-env:Envelope>`;

    const fault = new CdrExtractorUtil().extraerFault(xml);

    expect(fault).not.toBeNull();
    expect(fault?.faultCode).toContain('0154');
    expect(fault?.faultString).toContain('usuario o clave');
  });

  it('devuelve null cuando no hay applicationResponse ni content', () => {
    expect(new CdrExtractorUtil().extraerCdrXml('<algo/>')).toBeNull();
  });
});
