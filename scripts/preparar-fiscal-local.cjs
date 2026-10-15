/* Preparación local: genera la llave sin imprimirla y, opcionalmente, importa un .p12 SOLO en BETA. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, X509Certificate } = require('node:crypto');
const raiz = path.resolve(__dirname, '..');
const dotenv = require('dotenv');
const archivoLlave = path.join(raiz, '.env.fiscal.local');
dotenv.config({
  path: [archivoLlave, path.join(raiz, '.env.local'), path.join(raiz, '.env')],
  quiet: true,
});

async function main() {
  if (!process.env.FISCAL_SECRET_KEY) {
    const llave = randomBytes(32).toString('base64');
    fs.appendFileSync(archivoLlave, `\nFISCAL_SECRET_KEY=${llave}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.env.FISCAL_SECRET_KEY = llave;
    console.log(
      'Llave fiscal creada en .env.fiscal.local (archivo local excluido de Git).',
    );
  } else console.log('Se utiliza la llave fiscal ya configurada.');
  const posicion = process.argv.indexOf('--certificado');
  if (posicion < 0) return;
  const ruta = process.argv[posicion + 1];
  if (!ruta || !process.env.SUNAT_TEST_CERT_PASSWORD)
    throw new Error(
      'Indique --certificado <ruta> y SUNAT_TEST_CERT_PASSWORD en el entorno.',
    );
  const clave = process.env.SUNAT_TEST_CERT_PASSWORD;
  delete process.env.SUNAT_TEST_CERT_PASSWORD;
  require('reflect-metadata');
  require('ts-node/register');
  const { DataSource } = require('typeorm');
  const { Test } = require('@nestjs/testing');
  const { getDataSourceToken } = require('@nestjs/typeorm');
  const {
    ConfiguracionRepository,
  } = require('../src/repository/Repository/configuracion.repository');
  const {
    REGISTRO_SUNAT_CONFIG,
  } = require('../src/sunat/registro/config.registro');
  const {
    REGISTRO_SUNAT_NUCLEO,
  } = require('../src/sunat/registro/nucleo.registro');
  const {
    REGISTRO_SUNAT_EMISION,
  } = require('../src/sunat/registro/emision.registro');
  const {
    CertificadoFiscalService,
  } = require('../src/sunat/certificado/certificado-fiscal.service');
  const {
    leerPkcs12,
  } = require('../src/sunat/certificado/certificado-digital.util');
  const {
    EmisorBetaService,
  } = require('../src/sunat/emision/emisor-beta.service');
  const {
    PruebaConexionFiscalService,
  } = require('../src/sunat/config/prueba-conexion-fiscal.service');
  const {
    SunatEmisionBetaService,
  } = require('../src/sunat/emision/sunat-emision-beta.service');
  const {
    EnvioBetaRepository,
  } = require('../src/sunat/emision/envio-beta.repository');
  const buffer = fs.readFileSync(path.resolve(ruta));
  const leido = leerPkcs12(buffer, clave);
  const fuente = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    synchronize: false,
    entities: [],
    extra: { connectionTimeoutMillis: 10000, statement_timeout: 15000 },
  });
  await fuente.initialize();
  let modulo;
  try {
    modulo = await Test.createTestingModule({
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ...REGISTRO_SUNAT_NUCLEO.proveedores,
        ...REGISTRO_SUNAT_EMISION.proveedores,
        ConfiguracionRepository,
        { provide: getDataSourceToken('pgConnection'), useValue: fuente },
      ],
    }).compile();
    const certificados = modulo.get(CertificadoFiscalService);
    const actor = {
      id_usuario: null,
      nombre: 'Preparación local BETA',
      ip: null,
    };
    const actual = await certificados.infoActivo('beta');
    if (actual?.huella_sha256 !== leido.info.huellaSha256) {
      const certificado = await certificados.subir(
        { buffer, originalname: path.basename(ruta), size: buffer.length },
        clave,
        { ambiente: 'beta', forzar: true },
        actor,
      );
      console.log(
        JSON.stringify({
          certificado_cifrado_en_beta: certificado.id,
          ruc: certificado.ruc,
          bits: certificado.bits_clave,
        }),
      );
    } else console.log('El mismo certificado ya está cargado en BETA.');
    const beta = modulo.get(EmisorBetaService);
    const configurado = await beta.vista();
    if (configurado.emisor.ruc !== leido.info.ruc) {
      const razon = /^O=(.+)$/m.exec(
        new X509Certificate(leido.certificatePem).subject,
      )?.[1];
      if (!razon || !leido.info.ruc)
        throw new Error(
          'Complete el RUC y la razón social del emisor BETA desde el panel.',
        );
      await beta.guardar(
        {
          ruc: leido.info.ruc,
          razon_social: razon,
          nombre_comercial: '',
          direccion: 'DOMICILIO DE PRUEBA BETA - SIN VALOR TRIBUTARIO',
          ubigeo: '150119',
          distrito: 'LURIN',
          provincia: 'LIMA',
          departamento: 'LIMA',
          codigo_establecimiento: '0000',
        },
        actor,
      );
      console.log('Emisor separado de pruebas BETA guardado.');
    }
    if (process.argv.includes('--probar')) {
      for (const tipoCpe of ['01', '03']) {
        const resultado = await modulo
          .get(PruebaConexionFiscalService)
          .probar({ ambiente: 'beta', documento: 'cpe', tipoCpe }, actor);
        console.log(JSON.stringify({ tipo: tipoCpe, ...resultado }, null, 2));
        if (!resultado.ok) {
          process.exitCode = 1;
          break;
        }
      }
    }
    const reintentar = process.argv.indexOf('--reintentar');
    if (reintentar >= 0) {
      const ids = String(process.argv[reintentar + 1] || '')
        .split(',')
        .map(Number);
      if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1))
        throw new Error(
          'Indique los IDs BETA a recuperar separados por comas.',
        );
      for (const id of ids) {
        const resultado = await modulo
          .get(SunatEmisionBetaService)
          .reintentar(id);
        console.log(JSON.stringify(resultado, null, 2));
        if (!resultado.aceptado) {
          process.exitCode = 1;
          break;
        }
      }
    }
    if (process.argv.includes('--exportar')) {
      const repo = modulo.get(EnvioBetaRepository);
      const envios = await repo.listar();
      const destino = path.join(raiz, '.tmp/sunat-beta');
      fs.mkdirSync(destino, { recursive: true });
      for (const envio of envios) {
        const carpeta = path.join(
          destino,
          path.basename(envio.nombre_archivo, '.zip'),
        );
        fs.mkdirSync(carpeta, { recursive: true });
        for (const tipo of envio.archivos) {
          const archivo = await repo.archivo(envio.id_envio, tipo);
          if (archivo)
            fs.writeFileSync(
              path.join(carpeta, path.basename(archivo.nombre)),
              archivo.contenido,
            );
        }
      }
      fs.writeFileSync(
        path.join(destino, 'resumen.json'),
        JSON.stringify(envios, null, 2),
      );
      console.log(
        JSON.stringify({
          pruebas_exportadas: envios.length,
          directorio: destino,
        }),
      );
    }
  } finally {
    buffer.fill(0);
    if (modulo) await modulo.close();
    await fuente.destroy();
  }
}
main().catch((e) => {
  console.error(`Preparación fiscal: ${e.codigo || e.name}: ${e.message}`);
  process.exitCode = 1;
});
