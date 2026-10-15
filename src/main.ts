import './config/entorno';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import cookieParser from 'cookie-parser';
import { JWT_DEFAULT_DEV } from './config/jwt.config';
import { booleanoEntorno, esProduccion } from './config/runtime.config';
import { postgresConfigurado } from './config/database.config';
import { nubefactConfigurado } from './config/nubefact.config';
import { opcionesCors, origenesPermitidos } from './util/http/cors.config';
import { crearMiddlewareCabecerasSeguridad } from './util/http/cabeceras-seguridad.middleware';
import { crearMiddlewareRegistroPeticiones } from './util/http/registro-peticiones.middleware';
import { crearValidationPipe } from './util/http/validacion/validation-pipe.factory';
import { configServidorDesdeEntorno, configurarTiemposServidor } from './util/http/servidor-http';

function validarEntornoProduccion(): void {
  const esProd = esProduccion();

  const jwtSecret = process.env.JWT_SECRET ?? JWT_DEFAULT_DEV;
  if (esProd && (!process.env.JWT_SECRET || jwtSecret === JWT_DEFAULT_DEV)) {
    Logger.error(
      'JWT_SECRET no está definido (o usa el valor por defecto). Configúralo en Railway.',
      'Bootstrap',
    );
    throw new Error('JWT_SECRET obligatorio en producción');
  }

  if (esProd && !postgresConfigurado()) {
    Logger.error(
      'Base de datos no configurada. Defina DATABASE_URL o PGHOST + PGPASSWORD en Railway.',
      'Bootstrap',
    );
    throw new Error('DATABASE_URL obligatorio en producción');
  }

  const corsOrigin = (process.env.CORS_ORIGIN ?? '').trim();
  if (esProd && !corsOrigin) {
    Logger.error(
      'CORS_ORIGIN no está definido. Indique la URL exacta del frontend (Vercel).',
      'Bootstrap',
    );
    throw new Error('CORS_ORIGIN obligatorio en producción');
  }

  if (esProd && !nubefactConfigurado()) {
    Logger.warn(
      'NUBEFACT_URL / NUBEFACT_TOKEN no configurados: la emisión de comprobantes fallará hasta definirlos.',
      'Bootstrap',
    );
  }

  if (esProd && !process.env.SUNAT_TOKEN?.trim() && !process.env.APIPERU_TOKEN?.trim()) {
    Logger.warn(
      'SUNAT_TOKEN (ApiPeru) no configurado: las consultas de DNI/RUC fallarán hasta definirlo en Railway.',
      'Bootstrap',
    );
  }

  const tz = (process.env.TZ ?? '').trim();
  if (tz && !/^(utc|etc\/utc)$/i.test(tz)) {
    Logger.warn(
      `TZ=${tz}: node-postgres leerá los "timestamp" sin zona como hora local y desplazará las fechas. Quite TZ en Railway.`,
      'Bootstrap',
    );
  }

  if (esProd && !booleanoEntorno('LIMITE_PETICIONES_ACTIVO', true)) {
    Logger.warn('LIMITE_PETICIONES_ACTIVO=false: el límite de peticiones (login, DNI/RUC) está apagado.', 'Bootstrap');
  }
}

function montarSwagger(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('HatunSales API')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);
}

async function bootstrap() {
  validarEntornoProduccion();

  const esProd = esProduccion();
  const servidor = configServidorDesdeEntorno(esProd);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // Detrás del edge de Railway: req.ip es la IP real del cliente (X-Forwarded-For).
  app.set('trust proxy', servidor.confiarEnProxy);
  app.disable('x-powered-by');

  // Orden: id de petición y log → cabeceras → CORS (responde los preflight) → cookies → cuerpo.
  app.use(crearMiddlewareRegistroPeticiones({ umbralLentoMs: servidor.umbralPeticionLentaMs }));
  app.use(crearMiddlewareCabecerasSeguridad({ hsts: esProd }));
  app.enableCors(opcionesCors(origenesPermitidos({ corsOrigin: process.env.CORS_ORIGIN, produccion: esProd })));
  app.use(cookieParser());
  // JSON y formularios; las subidas multipart (imágenes, certificado .pfx) las limita multer en cada ruta.
  app.useBodyParser('json', { limit: servidor.limiteCuerpo });
  app.useBodyParser('urlencoded', { limit: servidor.limiteCuerpo, extended: true });
  app.useGlobalPipes(crearValidationPipe());

  // Los archivos de /uploads tienen nombre único (UUID): se pueden cachear.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/', maxAge: '7d', index: false });

  if (servidor.swagger) montarSwagger(app);

  // SIGTERM de Railway: deja de aceptar conexiones, termina las peticiones en curso y cierra el pool.
  app.enableShutdownHooks();
  configurarTiemposServidor(app.getHttpServer(), servidor.keepAliveMs);

  const puerto = process.env.PORT ?? 3000;
  await app.listen(puerto);

  logger.log(`Servidor escuchando en el puerto ${puerto}`);
  logger.log(servidor.swagger ? `Swagger: http://localhost:${puerto}/api` : 'Swagger desactivado (SWAGGER_ENABLED=true para activarlo).');
}
bootstrap();
