export const sunatConfig = {
  // Token de ApiPeruDev (consulta DNI/RUC). Si Railway define SUNAT_TOKEN, esa
  // variable gana; si no, se usa el de abajo para que el POS no quede ciego.
  token:
    process.env.SUNAT_TOKEN
    || process.env.APIPERU_TOKEN
    || process.env.APISPERU_TOKEN
    || process.env.TOKEN_SUNAT
    || '73fc3b03225461158a2bd701eefc638ec450b43471b0d88a7d0554c8a95cebe5',
  dniUrl: process.env.SUNAT_DNI_URL ?? 'https://apiperu.dev/api/dni',
  rucUrl: process.env.SUNAT_RUC_URL ?? 'https://apiperu.dev/api/ruc',
};

// ApiPeruDev: POST + Authorization: Bearer <token>
// Body DNI: { "dni": "71739060" }
// Body RUC: { "ruc": "20131312955" }
