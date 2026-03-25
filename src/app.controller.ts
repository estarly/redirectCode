import { Controller, Get, Param, Redirect } from '@nestjs/common';
import { TagsCodeService } from './tags-code.service';

type SupportedType = 'qr' | 'nfc';

@Controller()
export class AppController {
  private readonly fallbackBase =
    process.env.REDIRECT_FALLBACK_BASE ?? 'http://localhost:5173/redirect';

  constructor(private readonly tagsCodeService: TagsCodeService) {}

  @Get()
  index() {
    return {
      name: 'tags-redirect-api',
      version: '1.0.0',
    };
  }

  @Get(':code/:type')
  @Redirect()
  async redirectByCodeAndType(@Param('code') code: string, @Param('type') type: string) {
    const normalizedType = type.toLowerCase() as SupportedType;
    const fallbackUrl = `${this.fallbackBase}/${encodeURIComponent(code)}/${encodeURIComponent(normalizedType)}`;

    if (normalizedType !== 'qr' && normalizedType !== 'nfc') {
      return { url: fallbackUrl };
    }

    const tagCode = await this.tagsCodeService.findByCode(code);
    if (!tagCode) {
      return { url: fallbackUrl };
    }

    if (normalizedType === 'nfc' && tagCode.status_nfc === 1 && tagCode.link_nfc) {
      return { url: tagCode.link_nfc };
    }

    if (normalizedType === 'qr' && tagCode.status_qr === 1 && tagCode.link_qr) {
      return { url: tagCode.link_qr };
    }

    return { url: fallbackUrl };
  }
}
