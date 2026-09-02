import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';

import { AuthModule } from '../auth/auth.module';
import { LibraryModule } from '../library/library.module';
import { MetadataModule } from '../metadata/metadata.module';
import { InpxController } from './inpx.controller';
import { InpxGateway } from './inpx.gateway';
import { InpxImportService } from './inpx.import.service';
import { InpxParser } from './inpx.parser';
import { InpxProgressStore } from './inpx-progress.store';
import { InpxRepository } from './inpx.repository';
import { InpxService } from './inpx.service';

@Module({
  imports: [
    LibraryModule,
    MetadataModule,
    AuthModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtSecret'),
        signOptions: { expiresIn: config.getOrThrow<StringValue | number>('auth.jwtExpiresIn') },
      }),
    }),
  ],
  controllers: [InpxController],
  providers: [InpxService, InpxImportService, InpxRepository, InpxParser, InpxGateway, InpxProgressStore],
  exports: [InpxService],
})
export class InpxModule {}
