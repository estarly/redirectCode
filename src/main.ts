import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // IPs reales detrás de proxy/túnel
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API escuchando en http://localhost:${port}`);
}

bootstrap();
