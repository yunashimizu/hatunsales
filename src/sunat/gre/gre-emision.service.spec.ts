import { FiscalConfigError } from '../config/fiscal-errores';
import type { SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import type { CredencialesGre } from '../seguridad/credenciales-gre.service';
import type { GrePreparada, ResultadoConsultaGre, ResultadoEnvioGre } from './gre.contrato';
import { GreEmisionService } from './gre-emision.service';
import { PreparadorGre } from './preparador-gre';
import { greVentaPublica, HOY_GRE_PRUEBA, REMITENTE_GRE_PRUEBA } from './pruebas/documentos-gre-prueba-spec';

const RUC = REMITENTE_GRE_PRUEBA.ruc;
const CREDENCIALES: CredencialesGre = { clientId: 'a1b2c3d4-e5f6', clientSecret: 'secreto-123', usuarioSol: `${RUC}USUARIO1`, claveSol: 'ClaveSol9x' };

type Cambios = Partial<Omit<SnapshotConfigFiscal, 'gre'>> & { greActiva?: boolean };

function snapshot(cambios: Cambios = {}): SnapshotConfigFiscal {
  const { greActiva, ...resto } = cambios;
  return {
    ambiente: 'produccion',
    proveedor: 'sunat_directo',
    emisor: { ...REMITENTE_GRE_PRUEBA },
    series: { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', nc_boleta: 'BC01', nd_factura: 'FD01', nd_boleta: 'BD01', gre_remitente: 'T001' },
    solUsuario: 'USUARIO1',
    certRucConfirmadoProduccion: false,
    bloqueos: { beta: null, produccion: null },
    gre: {
      activa: greActiva ?? true,
      serie: 'T001',
      correlativoInicial: 1,
      partida: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' },
      partidaHeredada: { ubigeo: true, direccion: true, codigoEstablecimiento: true },
    },
    ...resto,
  } as unknown as SnapshotConfigFiscal;
}

const certificadoInfo = (cambios: Record<string, unknown> = {}) => ({ ruc: RUC, vencido: false, autofirmado: false, ...cambios });

// Un solo certificado para todo el spec (generar claves RSA es lento), vigente en la fecha fija del reloj.
const CERTIFICADO = generarCertificadoPrueba({ desde: new Date('2026-01-01T00:00:00Z'), hasta: new Date('2027-12-31T00:00:00Z') });

function crear(opciones: { snapshot?: SnapshotConfigFiscal; ruc?: string | null; usuarioSol?: string } = {}) {
  const material = { ...materialDePrueba(CERTIFICADO), autofirmado: false, ruc: opciones.ruc === undefined ? RUC : opciones.ruc };
  const config = {
    snapshot: jest.fn(() => Promise.resolve(opciones.snapshot ?? snapshot())),
    emisor: jest.fn(() => Promise.resolve({ ...(opciones.snapshot ?? snapshot()).emisor })),
  };
  const certificado = {
    obtenerMaterialFirma: jest.fn(() => Promise.resolve(material)),
    obtenerCredencialesSol: jest.fn(() => Promise.resolve({ usuario: opciones.usuarioSol ?? `${RUC}USUARIO1`, clave: 'ClaveSol9x' })),
    obtenerCredencialesGre: jest.fn(() => Promise.resolve({ ...CREDENCIALES, usuarioSol: opciones.usuarioSol ?? CREDENCIALES.usuarioSol })),
    infoActivo: jest.fn(() => Promise.resolve(certificadoInfo())),
  };
  const credencialesGre = { diagnostico: jest.fn(() => Promise.resolve('ok')) };
  const credencialesSol = { diagnosticoClave: jest.fn(() => Promise.resolve('ok')) };
  const reloj = { ahora: () => new Date(`${HOY_GRE_PRUEBA}T15:00:00Z`), fechaLima: () => HOY_GRE_PRUEBA };
  const preparador = new PreparadorGre();
  const prepararEspia = jest.spyOn(preparador, 'preparar');
  const cliente = {
    enviarGre: jest.fn(
      (): Promise<ResultadoEnvioGre> =>
        Promise.resolve({
          estado: 'TICKET_PENDIENTE',
          ticket: 't-1',
          fechaRecepcion: null,
          codigo: null,
          mensaje: 'recibido',
          errores: [],
          accion: 'CONSULTAR_TICKET',
        }),
    ),
    consultarTicket: jest.fn(
      (): Promise<ResultadoConsultaGre> =>
        Promise.resolve({
          estado: 'TICKET_PENDIENTE',
          codigo: '98',
          mensaje: 'en proceso',
          errores: [],
          accion: 'CONSULTAR_TICKET',
          cdr: null,
        }),
    ),
  };
  const servicio = new GreEmisionService(
    config as never,
    certificado as never,
    credencialesGre as never,
    credencialesSol as never,
    reloj as never,
    preparador,
    cliente as never,
  );
  return { servicio, config, certificado, credencialesGre, credencialesSol, prepararEspia, cliente, material };
}

describe('GreEmisionService', () => {
  describe('modo()', () => {
    it('en BETA está inactivo: la GRE no tiene ambiente de pruebas', async () => {
      const { servicio } = crear({ snapshot: snapshot({ ambiente: 'beta' }) });
      const modo = await servicio.modo();
      expect(modo).toEqual({ activo: false, codigo: 'GRE_SIN_BETA', motivo: expect.stringContaining('La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar') });
    });

    it('activo solo con producción + GRE activa + credenciales API + SOL + certificado del emisor', async () => {
      expect(await crear().servicio.modo()).toEqual({ activo: true });
    });

    it.each([
      ['GRE desactivada', { snapshot: snapshot({ greActiva: false }) }, 'GRE_DESACTIVADA'],
      ['emisión detenida por el interruptor', { snapshot: snapshot({ bloqueos: { beta: null, produccion: { codigo: '0102', motivo: 'clave SOL', fecha: '2026-10-21T10:00:00Z' } } }) }, 'FISCAL_EMISION_BLOQUEADA'],
      ['sin usuario SOL', { snapshot: snapshot({ solUsuario: null }) }, 'FISCAL_CREDENCIALES_SOL_FALTAN'],
    ])('%s: inactivo con su código', async (_nombre, opciones, codigo) => {
      const modo = await crear(opciones).servicio.modo();
      expect(modo).toMatchObject({ activo: false, codigo });
    });

    it('explica cada faltante de credenciales y certificado', async () => {
      const casos: Array<[(d: ReturnType<typeof crear>) => void, string]> = [
        [(d) => d.credencialesGre.diagnostico.mockResolvedValue('falta'), 'FISCAL_CREDENCIALES_GRE_FALTAN'],
        [(d) => d.credencialesGre.diagnostico.mockResolvedValue('ilegible'), 'FISCAL_SECRETO_ILEGIBLE'],
        [(d) => d.credencialesGre.diagnostico.mockResolvedValue('sin_cifrado'), 'FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA'],
        [(d) => d.credencialesSol.diagnosticoClave.mockResolvedValue('falta'), 'FISCAL_CREDENCIALES_SOL_FALTAN'],
        [(d) => d.certificado.infoActivo.mockResolvedValue(null as never), 'FISCAL_CERT_NO_CARGADO'],
        [(d) => d.certificado.infoActivo.mockResolvedValue(certificadoInfo({ vencido: true })), 'FISCAL_CERT_VENCIDO'],
        [(d) => d.certificado.infoActivo.mockResolvedValue(certificadoInfo({ autofirmado: true })), 'FISCAL_CERT_AUTOFIRMADO'],
        [(d) => d.certificado.infoActivo.mockResolvedValue(certificadoInfo({ ruc: '20553856451' })), 'FISCAL_CERT_RUC_NO_COINCIDE'],
        [(d) => d.certificado.infoActivo.mockResolvedValue(certificadoInfo({ ruc: null })), 'FISCAL_CERT_RUC_SIN_CONFIRMAR'],
      ];
      for (const [preparar, codigo] of casos) {
        const dobles = crear();
        preparar(dobles);
        const modo = await dobles.servicio.modo();
        expect(modo).toMatchObject({ activo: false, codigo });
        expect(modo.activo === false && modo.motivo.length > 10).toBe(true);
      }
    });

    it('un certificado sin RUC legible confirmado por el administrador sí permite emitir', async () => {
      const dobles = crear({ snapshot: snapshot({ certRucConfirmadoProduccion: true }) });
      dobles.certificado.infoActivo.mockResolvedValue(certificadoInfo({ ruc: null }));
      expect(await dobles.servicio.modo()).toEqual({ activo: true });
    });

    it('nunca lanza: si no se puede leer la configuración responde FISCAL_LECTURA_ERROR', async () => {
      const dobles = crear();
      dobles.config.snapshot.mockRejectedValue(new Error('conexión cerrada'));
      await expect(dobles.servicio.modo()).resolves.toMatchObject({ activo: false, codigo: 'FISCAL_LECTURA_ERROR' });
    });
  });

  describe('contexto() y validar()', () => {
    it('emisor configurado, serie de la GRE y partida por defecto', async () => {
      const contexto = await crear().servicio.contexto();
      expect(contexto.emisor.ruc).toBe(RUC);
      expect(contexto.serie).toBe('T001');
      expect(contexto.partidaPorDefecto).toEqual({ ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' });
    });

    it('lanza FiscalConfigError si el emisor no tiene RUC válido', async () => {
      const { servicio } = crear({ snapshot: snapshot({ emisor: { ...REMITENTE_GRE_PRUEBA, ruc: '123' } }) });
      await expect(servicio.contexto()).rejects.toBeInstanceOf(FiscalConfigError);
    });

    it('validar usa la fecha de Lima del reloj fiscal', () => {
      const { servicio } = crear();
      expect(servicio.validar(greVentaPublica()).errores).toEqual([]);
      expect(servicio.validar(greVentaPublica({ fechaEmision: '2026-10-22', envio: { fechaInicioTraslado: '2026-10-22' } })).errores.join(' ')).toContain('posterior a hoy');
    });
  });

  describe('prepararDocumento(): guardas duras antes de firmar', () => {
    it('firma con el material de producción cuando todo corresponde al emisor', async () => {
      const dobles = crear();
      const preparada = await dobles.servicio.prepararDocumento(greVentaPublica());
      expect(dobles.certificado.obtenerMaterialFirma).toHaveBeenCalledWith('produccion');
      expect(preparada.nombreBase).toBe('20610206337-09-T001-00000001');
      expect(preparada.xmlFirmado).toContain('ds:SignatureValue');
    });

    it('certificado de otro RUC: FISCAL_CERT_RUC_NO_COINCIDE y no se firma', async () => {
      const dobles = crear({ ruc: '20553856451' });
      await expect(dobles.servicio.prepararDocumento(greVentaPublica())).rejects.toMatchObject({ codigo: 'FISCAL_CERT_RUC_NO_COINCIDE' });
      expect(dobles.prepararEspia).not.toHaveBeenCalled();
    });

    it('certificado sin RUC legible: exige la confirmación del administrador', async () => {
      const sinConfirmar = crear({ ruc: null });
      await expect(sinConfirmar.servicio.prepararDocumento(greVentaPublica())).rejects.toMatchObject({ codigo: 'FISCAL_CERT_RUC_SIN_CONFIRMAR' });
      expect(sinConfirmar.prepararEspia).not.toHaveBeenCalled();

      const confirmado = crear({ ruc: null, snapshot: snapshot({ certRucConfirmadoProduccion: true }) });
      await expect(confirmado.servicio.prepararDocumento(greVentaPublica())).resolves.toMatchObject({ nombreBase: '20610206337-09-T001-00000001' });
    });

    it('usuario SOL de otro RUC: FISCAL_SOL_RUC_NO_COINCIDE y no se firma', async () => {
      const dobles = crear({ usuarioSol: '20553856451USUARIO1' });
      await expect(dobles.servicio.prepararDocumento(greVentaPublica())).rejects.toMatchObject({ codigo: 'FISCAL_SOL_RUC_NO_COINCIDE' });
      expect(dobles.prepararEspia).not.toHaveBeenCalled();
    });

    it('remitente distinto del emisor configurado: se rechaza antes de pedir el certificado', async () => {
      const dobles = crear();
      const documento = greVentaPublica();
      documento.remitente = { ...documento.remitente, ruc: '20553856451' };
      await expect(dobles.servicio.prepararDocumento(documento)).rejects.toBeInstanceOf(FiscalConfigError);
      expect(dobles.certificado.obtenerMaterialFirma).not.toHaveBeenCalled();
    });

    it('una guía inválida no se firma (GreInvalidaError)', async () => {
      const dobles = crear();
      await expect(dobles.servicio.prepararDocumento(greVentaPublica({ envio: { motivo: '02' } }))).rejects.toMatchObject({ codigo: 'FISCAL_DOCUMENTO_INVALIDO' });
    });
  });

  describe('enviar() y consultarTicket(): nunca lanzan', () => {
    let preparada: GrePreparada;
    beforeAll(async () => {
      preparada = await crear().servicio.prepararDocumento(greVentaPublica());
    });

    it('con la emisión inactiva (BETA) no llama a SUNAT', async () => {
      const dobles = crear({ snapshot: snapshot({ ambiente: 'beta' }) });
      const resultado = await dobles.servicio.enviar(preparada);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
      expect(resultado.mensaje).toContain('La GRE no tiene ambiente de pruebas');
      expect(dobles.cliente.enviarGre).not.toHaveBeenCalled();
    });

    it('activa: envía con las credenciales de producción', async () => {
      const dobles = crear();
      const resultado = await dobles.servicio.enviar(preparada);
      expect(resultado.estado).toBe('TICKET_PENDIENTE');
      expect(dobles.certificado.obtenerCredencialesGre).toHaveBeenCalledWith('produccion');
      expect(dobles.cliente.enviarGre).toHaveBeenCalledWith(expect.objectContaining({ clientId: CREDENCIALES.clientId }), preparada);
    });

    it('si faltan credenciales o el usuario SOL es de otro RUC, devuelve ERROR_CONFIG sin enviar', async () => {
      const sinCredenciales = crear();
      sinCredenciales.certificado.obtenerCredencialesGre.mockRejectedValue(new FiscalConfigError('FISCAL_CREDENCIALES_GRE_FALTAN', 'Registre el client_id.'));
      await expect(sinCredenciales.servicio.enviar(preparada)).resolves.toMatchObject({ estado: 'ERROR_CONFIG', mensaje: expect.stringContaining('Registre el client_id') });
      expect(sinCredenciales.cliente.enviarGre).not.toHaveBeenCalled();

      const otroRuc = crear({ usuarioSol: '20553856451USUARIO1' });
      await expect(otroRuc.servicio.enviar(preparada)).resolves.toMatchObject({ estado: 'ERROR_CONFIG' });
      expect(otroRuc.cliente.enviarGre).not.toHaveBeenCalled();
    });

    it('consulta el ticket con la guía esperada; con la emisión detenida no consulta', async () => {
      const dobles = crear();
      const esperada = { rucEmisor: RUC, serie: 'T001', numero: 1 };
      await expect(dobles.servicio.consultarTicket('t-1', esperada)).resolves.toMatchObject({ estado: 'TICKET_PENDIENTE' });
      expect(dobles.cliente.consultarTicket).toHaveBeenCalledWith(expect.objectContaining({ clientId: CREDENCIALES.clientId }), 't-1', esperada);

      const bloqueada = crear({ snapshot: snapshot({ bloqueos: { beta: null, produccion: { codigo: '0102', motivo: 'clave', fecha: 'x' } } }) });
      await expect(bloqueada.servicio.consultarTicket('t-1')).resolves.toMatchObject({ estado: 'ERROR_CONFIG' });
      expect(bloqueada.cliente.consultarTicket).not.toHaveBeenCalled();

      const sinCredenciales = crear();
      sinCredenciales.certificado.obtenerCredencialesGre.mockRejectedValue(new Error('sin llave'));
      await expect(sinCredenciales.servicio.consultarTicket('t-1')).resolves.toMatchObject({ estado: 'ERROR_CONFIG' });
    });
  });
});
