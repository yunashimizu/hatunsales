export const sunatConfig = {
  token: process.env.SUNAT_TOKEN ?? '',
  dniUrl: process.env.SUNAT_DNI_URL ?? 'https://dniruc.apisperu.com/api/v1/dni',
  rucUrl: process.env.SUNAT_RUC_URL ?? 'https://dniruc.apisperu.com/api/v1/ruc',
};

// la URL final que se arma es:
// https://dniruc.apisperu.com/api/v1/dni/71739060?token=eyJ0eXAi...
// https://dniruc.apisperu.com/api/v1/ruc/20131312955?token=eyJ0eXAi...