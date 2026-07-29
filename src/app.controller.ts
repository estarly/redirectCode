import { Controller, Get, Headers, Param, Redirect } from '@nestjs/common';
import { TagsCodeService } from './tags-code.service';

type SupportedType = 'qr' | 'nfc';

/**
 * Destinos estáticos de error en mobile-v2 (`/e/:code`).
 * El front no vuelve a consultar BD: solo muestra el mensaje prestablecido.
 */
const ERROR_PATHS = {
  'not-found': '/e/not-found',
  'invalid-type': '/e/invalid-type',
  'register-qr-only': '/e/register-qr-only',
  'nfc-requires-qr': '/e/nfc-requires-qr',
  disabled: '/e/disabled',
  'profile-not-ready': '/e/profile-not-ready',
  unavailable: '/e/unavailable',
} as const;

@Controller()
export class AppController {
  private readonly appBase = (
    process.env.APP_BASE_URL ??
    process.env.REDIRECT_FALLBACK_BASE ??
    'http://localhost:5173'
  ).replace(/\/+$/, '');

  private readonly profilePublicBase = (
    process.env.PROFILE_PUBLIC_BASE_URL ?? this.appBase
  ).replace(/\/+$/, '');

  constructor(private readonly tagsCodeService: TagsCodeService) {}

  @Get()
  index() {
    return {
      name: 'tags-redirect-api',
      version: '1.2.0',
      route: 'GET /redirect/:type/:code',
    };
  }

  /** Ruta canónica del QR/NFC físico: qr.dominio.com/redirect/qr|nfc/CODE */
  @Get('redirect/:type/:code')
  @Redirect()
  async redirectCanonical(
    @Param('type') type: string,
    @Param('code') code: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return {
      url: await this.resolveDestination(code, type, userAgent),
      statusCode: 302,
    };
  }

  /** Alias legacy: /CODE/qr|nfc — mantener etiquetas ya impresas */
  @Get(':code/:type')
  @Redirect()
  async redirectLegacy(
    @Param('code') code: string,
    @Param('type') type: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return {
      url: await this.resolveDestination(code, type, userAgent),
      statusCode: 302,
    };
  }

  private errorUrl(key: keyof typeof ERROR_PATHS): string {
    return `${this.appBase}${ERROR_PATHS[key]}`;
  }

  private loginIncompleteUrl(): string {
    return `${this.appBase}/login/?reason=profile_incomplete`;
  }

  private registerUrl(code: string, tagId: number): string {
    const q = `code=${encodeURIComponent(code)}&type=qr&tagId=${encodeURIComponent(String(tagId))}`;
    return `${this.appBase}/activate-profile/?${q}`;
  }

  private buildOfficialPublicUrl(tag: {
    link_qr: string | null;
    profile_slug: string | null;
    profile_custom_domain: string | null;
  }): string | null {
    const custom = String(tag.profile_custom_domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (custom) {
      return `https://${custom}`;
    }
    const link = String(tag.link_qr ?? '').trim();
    if (link) return link;
    const slug = String(tag.profile_slug ?? '').trim().replace(/^\/+/, '');
    if (!slug) return null;
    return `${this.profilePublicBase}/p/${encodeURIComponent(slug)}`;
  }

  private async resolveDestination(
    codeRaw: string,
    typeRaw: string,
    userAgent?: string,
  ): Promise<string> {
    const code = String(codeRaw ?? '').trim();
    const normalizedType = String(typeRaw ?? '')
      .trim()
      .toLowerCase() as SupportedType;
    const platform = TagsCodeService.platformFromUa(userAgent);

    const record = (
      result: string,
      tag?: { id?: number; user_id?: number | null } | null,
    ) => {
      void this.tagsCodeService.recordScanEvent({
        code: code || 'unknown',
        type: normalizedType === 'nfc' ? 'nfc' : 'qr',
        result,
        ownerUserId: tag?.user_id ?? null,
        tagId: tag?.id ?? null,
        platform,
      });
    };

    if (!code) {
      record('not-found');
      return this.errorUrl('not-found');
    }

    if (normalizedType !== 'qr' && normalizedType !== 'nfc') {
      record('invalid-type');
      return this.errorUrl('invalid-type');
    }

    const tag = await this.tagsCodeService.findByCodeWithProfile(code);
    if (!tag) {
      record('not-found');
      return this.errorUrl('not-found');
    }

    if (normalizedType === 'nfc') {
      const url = this.resolveNfc(tag);
      record(this.resultFromUrl(url, tag), tag);
      return url;
    }

    const url = this.resolveQr(tag);
    record(this.resultFromUrl(url, tag), tag);
    return url;
  }

  /** Mapea destino a result para analytics (ok solo si llega a perfil público). */
  private resultFromUrl(
    url: string,
    tag: { profile_status: number | null; status_qr: number },
  ): string {
    if (url.includes('/activate-profile')) return 'register';
    if (url.includes('profile_incomplete')) return 'incomplete';
    if (url.includes('/e/not-found')) return 'not-found';
    if (url.includes('/e/')) return url.split('/e/')[1]?.split(/[/?#]/)[0] || 'error';
    if (tag.profile_status === 1 && tag.status_qr === 1) return 'ok';
    return 'redirect';
  }

  private resolveNfc(tag: Awaited<
    ReturnType<TagsCodeService['findByCodeWithProfile']>
  >): string {
    if (!tag) return this.errorUrl('not-found');

    if (tag.status_qr !== 1) {
      return this.errorUrl('nfc-requires-qr');
    }

    if (tag.status_nfc === 0) {
      return this.errorUrl('register-qr-only');
    }

    if (tag.status_nfc === 1) {
      const link = String(tag.link_nfc ?? '').trim();
      if (link) return link;
      return this.errorUrl('unavailable');
    }

    if (tag.profile_status === 2) {
      return this.loginIncompleteUrl();
    }
    return this.errorUrl('disabled');
  }

  private resolveQr(tag: NonNullable<
    Awaited<ReturnType<TagsCodeService['findByCodeWithProfile']>>
  >): string {
    if (tag.status_qr === 0) {
      return this.registerUrl(tag.code, tag.id);
    }

    if (tag.status_qr === 1) {
      if (tag.profile_status === 1) {
        const url = this.buildOfficialPublicUrl(tag);
        if (url) return url;
        return this.errorUrl('profile-not-ready');
      }
      if (tag.profile_status === 2) {
        return this.loginIncompleteUrl();
      }
      return this.errorUrl('profile-not-ready');
    }

    if (tag.profile_status === 2) {
      return this.loginIncompleteUrl();
    }

    if (tag.user_id && tag.profile_status === 1) {
      return this.errorUrl('disabled');
    }

    return this.errorUrl('disabled');
  }
}
