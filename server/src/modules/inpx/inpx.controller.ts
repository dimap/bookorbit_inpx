import { Permission } from '@bookorbit/types';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { RegisterInpxArchiveDto } from './dto/register-inpx-archive.dto';
import { InpxService } from './inpx.service';

@Controller('inpx')
export class InpxController {
  constructor(private readonly inpxService: InpxService) {}

  @Post('libraries/:libraryId/archives')
  @RequirePermission(Permission.LibraryUpload)
  @RequireLibraryAccess('editor')
  register(@Param('libraryId', ParseIntPipe) libraryId: number, @Body() dto: RegisterInpxArchiveDto, @CurrentUser() user: RequestUser) {
    return this.inpxService.register(libraryId, dto, user);
  }

  @Get('libraries/:libraryId/archives')
  @RequireLibraryAccess('viewer')
  list(@Param('libraryId', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser) {
    return this.inpxService.list(libraryId, user);
  }

  @Get('archives/:id')
  @RequireLibraryAccess('viewer')
  get(@Param('id', ParseIntPipe) archiveId: number, @CurrentUser() user: RequestUser) {
    return this.inpxService.get(archiveId, user);
  }

  @Post('archives/:id/import')
  @RequirePermission(Permission.LibraryUpload)
  @RequireLibraryAccess('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  import(@Param('id', ParseIntPipe) archiveId: number, @CurrentUser() user: RequestUser) {
    return this.inpxService.import(archiveId, user);
  }

  @Delete('archives/:id')
  @RequirePermission(Permission.LibraryUpload)
  @RequireLibraryAccess('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) archiveId: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.inpxService.remove(archiveId, user);
  }
}
