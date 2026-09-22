import { SunatBillClient } from './sunat-bill.client';

describe('SunatBillClient', () => {
  it('arma el envelope SOAP con UsernameToken para sendBill', () => {
    const client = new SunatBillClient({
      username: '20123456789MODDATOS',
      password: 'MODDATOS',
      endpoint: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
    });

    const envelope = client.buildSendBillEnvelope('20123456789-01-F001-00000001.zip', 'UklQ');

    expect(envelope).toContain('sendBill');
    expect(envelope).toContain('20123456789MODDATOS');
    expect(envelope).toContain('MODDATOS');
    expect(envelope).toContain('20123456789-01-F001-00000001.zip');
    expect(envelope).toContain('<contentFile>UklQ</contentFile>');
  });
});
