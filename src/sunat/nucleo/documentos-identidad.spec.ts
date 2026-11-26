import { esDniValido, esRucValido } from './documentos-identidad';

/**
 * Estos casos están copiados TAL CUAL en el spec del navegador
 * (ferreteria/src/app/shared/utils/documento-identidad.util.spec.ts): el panel y el
 * servidor tienen que decir lo mismo de cada número. Si agrega uno aquí, agréguelo allá.
 */
const RUC_VALIDOS: Array<string> = [
  '20131312955', // SUNAT
  '20100047218',
  '20100070970',
  '10123456781', // persona natural
  '20123456786',
  '15000000016',
  '16000000012',
  '17000000019',
  '20000000010', // 11 − (suma % 11) = 10 → dígito 0
  '20000000061', // 11 − (suma % 11) = 11 → dígito 1
  ' 20131312955 ', // se recortan los espacios de los extremos
];

const RUC_INVALIDOS: Array<string | null | undefined> = [
  '20131312954', // dígito verificador cambiado
  '20123456789',
  '10101010101',
  '30123456786', // prefijo 30: no es de contribuyente
  '11123456781', // prefijo 11
  '12345678901', // prefijo 12
  '2013131295', // 10 dígitos
  '201313129550', // 12 dígitos
  '2013131295a',
  '20 131312955', // espacio en medio
  '20-131312955',
  '',
  '   ',
  null,
  undefined,
];

const DNI_VALIDOS: Array<string> = ['12345678', '00000000', '71739060', ' 12345678 '];
const DNI_INVALIDOS: Array<string | null | undefined> = ['1234567', '123456789', '1234567a', '1234 5678', '', null, undefined];

describe('esRucValido (los mismos casos que validarRuc del panel)', () => {
  it.each(RUC_VALIDOS)('«%s» es válido', (ruc) => {
    expect(esRucValido(ruc)).toBe(true);
  });

  it.each(RUC_INVALIDOS)('«%s» no es válido', (ruc) => {
    expect(esRucValido(ruc)).toBe(false);
  });
});

describe('esDniValido (los mismos casos que validarDni del panel)', () => {
  it.each(DNI_VALIDOS)('«%s» es válido', (dni) => {
    expect(esDniValido(dni)).toBe(true);
  });

  it.each(DNI_INVALIDOS)('«%s» no es válido', (dni) => {
    expect(esDniValido(dni)).toBe(false);
  });
});
