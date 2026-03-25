import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { TagsCodeService } from './tags-code.service';

@Module({
  controllers: [AppController],
  providers: [TagsCodeService],
})
export class AppModule {}
