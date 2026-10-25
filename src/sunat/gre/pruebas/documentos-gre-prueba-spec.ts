/**
 * Guías de prueba SOLO para specs y para generar muestras XML (el sufijo -spec.ts lo excluye del build y
 * jest no lo ejecuta como suite). Datos ficticios: nada de esto se envía a SUNAT.
 */
import type { EmisorCpe } from '../../nucleo/documento-fiscal.types';
import type { DocumentoGre } from '../gre.tipos';

export const HOY_GRE_PRUEBA = '2026-10-21';

export const REMITENTE_GRE_PRUEBA: EmisorCpe = Object.freeze({
  ruc: '20610206337',
  razonSocial: 'HATUNSALES S.A.C.',
  direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
  ubigeo: '150119',
  distrito: 'LURIN',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
});

type CambiosGre = Partial<Omit<DocumentoGre, 'envio'>> & { envio?: Partial<DocumentoGre['envio']> };

function aplicar(base: DocumentoGre, cambios: CambiosGre): DocumentoGre {
  const { envio, ...resto } = cambios;
  return { ...base, ...resto, envio: { ...base.envio, ...(envio ?? {}) } };
}

/** Venta (01) por transporte público, con la factura relacionada. */
export function greVentaPublica(cambios: CambiosGre = {}): DocumentoGre {
  return aplicar(
    {
      tipo: '09',
      serie: 'T001',
      numero: 1,
      fechaEmision: HOY_GRE_PRUEBA,
      horaEmision: '10:15:30',
      remitente: { ...REMITENTE_GRE_PRUEBA },
      destinatario: { tipoDoc: '6', numDoc: '20553856451', nombre: 'CONSTRUCTORA LOS ANDES S.A.C.' },
      envio: {
        motivo: '01',
        modalidad: '01',
        fechaInicioTraslado: HOY_GRE_PRUEBA,
        pesoBrutoTotal: 1250.5,
        unidadPeso: 'KGM',
        numeroBultos: 25,
        partida: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' },
        llegada: { ubigeo: '150122', direccion: 'AV. JOSE LARCO 1150, MIRAFLORES' },
      },
      transportista: { tipoDoc: '6', numDoc: '20100066603', razonSocial: 'TRANSPORTES DEL SUR S.A.C.', registroMtc: '1534567CNG' },
      items: [
        { cantidad: 25, unidad: 'BG', descripcion: 'CEMENTO SOL TIPO I BOLSA 42.5 KG', codigoInterno: 'CEM-001', codigoSunat: '30111601' },
      ],
      documentosRelacionados: [{ tipo: '01', serie: 'F001', numero: '125' }],
    },
    cambios,
  );
}

/** Traslado entre establecimientos de la misma empresa (04) con vehículo y conductor propios. */
export function greTrasladoPrivado(cambios: CambiosGre = {}): DocumentoGre {
  return aplicar(
    {
      tipo: '09',
      serie: 'T001',
      numero: 2,
      fechaEmision: HOY_GRE_PRUEBA,
      horaEmision: '11:00:00',
      remitente: { ...REMITENTE_GRE_PRUEBA },
      destinatario: { tipoDoc: '6', numDoc: REMITENTE_GRE_PRUEBA.ruc, nombre: REMITENTE_GRE_PRUEBA.razonSocial },
      envio: {
        motivo: '04',
        modalidad: '02',
        fechaInicioTraslado: '2026-10-22',
        pesoBrutoTotal: 0.75,
        unidadPeso: 'TNE',
        partida: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' },
        llegada: { ubigeo: '150101', direccion: 'JR. AYACUCHO 450, CERCADO DE LIMA', codigoEstablecimiento: '0001' },
      },
      vehiculo: { placa: 'ABC123', tarjetaCirculacion: '15M21012345' },
      conductores: [
        { tipoDoc: '1', numDoc: '45678912', nombres: 'JUAN CARLOS', apellidos: 'PEREZ QUISPE', licencia: 'Q45678912' },
        { tipoDoc: '1', numDoc: '41234567', nombres: 'ROSA', apellidos: 'MAMANI TORRES', licencia: 'A41234567' },
      ],
      items: [
        { cantidad: 10, unidad: 'NIU', descripcion: 'TALADRO PERCUTOR BOSCH GSB 13 RE', codigoInterno: 'HER-010' },
        { cantidad: 2.5, unidad: 'MTR', descripcion: 'CABLE THW 14 AWG INDECO' },
        { cantidad: 40, unidad: 'KGM', descripcion: 'CLAVO DE ALAMBRE 3 PULGADAS' },
      ],
    },
    cambios,
  );
}

/** Otros (13) con descripción del motivo, transporte privado y textos con caracteres especiales. */
export function greOtrosPrivado(cambios: CambiosGre = {}): DocumentoGre {
  return aplicar(
    {
      tipo: '09',
      serie: 'T001',
      numero: 3,
      fechaEmision: HOY_GRE_PRUEBA,
      horaEmision: '16:45:05',
      remitente: { ...REMITENTE_GRE_PRUEBA },
      destinatario: { tipoDoc: '1', numDoc: '45678912', nombre: "JOSÉ D'ANGELO & ÑAHUI <TALLER>" },
      envio: {
        motivo: '13',
        descripcionMotivo: 'TRASLADO A REPARACIÓN DE EQUIPO',
        modalidad: '02',
        fechaInicioTraslado: HOY_GRE_PRUEBA,
        pesoBrutoTotal: 35,
        unidadPeso: 'KGM',
        partida: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN' },
        llegada: { ubigeo: '040101', direccion: 'CALLE MERCADERES 210 "TALLER" & ANEXO, AREQUIPA' },
      },
      vehiculo: { placa: 'B7Q456' },
      conductores: [{ tipoDoc: '1', numDoc: '45678912', nombres: 'JOSÉ', apellidos: "D'ANGELO ÑAHUI", licencia: 'Q45678912' }],
      items: [{ cantidad: 1, unidad: 'NIU', descripcion: 'GENERADOR 5 KW <SERIE 12-AB> & ACCESORIOS "KIT" Ñ°' }],
      observaciones: 'EQUIPO EN GARANTÍA: REVISAR ANTES DE ENTREGAR & FIRMAR',
    },
    cambios,
  );
}
