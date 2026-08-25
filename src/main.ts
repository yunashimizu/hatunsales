import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import { join } from 'path';
import cookieParser from 'cookie-parser';
import { JWT_DEFAULT_DEV } from './config/jwt.config';
import { esProduccion } from './config/runtime.config';
import { postgresConfigurado } from './config/database.config';
import { nubefactConfigurado } from './config/nubefact.config';

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
}

async function bootstrap() {
  validarEntornoProduccion();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const esProd = esProduccion();

  const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const corsOrigins = esProd
    ? allowedOrigins
    : (allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:4200']);

  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    origin: corsOrigins,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

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

  await app.listen(process.env.PORT ?? 3000);

  console.log(`Servidor:  http://localhost:${process.env.PORT ?? 3000}`);
  console.log(`Swagger:   http://localhost:${process.env.PORT ?? 3000}/api`);
}
bootstrap();
