import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import { join } from 'path';
import cookieParser from 'cookie-parser';
import { JWT_DEFAULT_DEV } from './config/jwt.config';

async function bootstrap() {
  const esProd =
    (process.env.NODE_ENV ?? '').toLowerCase() === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME;

  const jwtSecret = process.env.JWT_SECRET ?? JWT_DEFAULT_DEV;
  if (esProd && (!process.env.JWT_SECRET || jwtSecret === JWT_DEFAULT_DEV)) {
    Logger.error(
      'JWT_SECRET no está definido (o usa el valor por defecto). Configúralo en Railway antes de subir a producción.',
      'Bootstrap',
    );
    throw new Error('JWT_SECRET obligatorio en producción');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  });
  app.useGlobalPipes(new ValidationPipe());

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
