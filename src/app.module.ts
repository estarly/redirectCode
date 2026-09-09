import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { TagsCodeService } from './tags-code.service';
import { GatewaySecurityService } from './gateway-security.service';

@Module({
  controllers: [AppController],
  providers: [TagsCodeService, GatewaySecurityService],
})
export class AppModule {}
