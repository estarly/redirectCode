import {
  Controller,
  Get,
  Headers,
  Param,
  Redirect,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { TagsCodeService } from './tags-code.service';
import { GatewaySecurityService } from './gateway-security.service';

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

  constructor(
    private readonly tagsCodeService: TagsCodeService,
    private readonly security: GatewaySecurityService,
  ) {}

  private isLoopbackHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }

  private clientIp(req: Request): string {
    const xf = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      ?.trim();
    if (xf) return xf.slice(0, 64);
    const realIp = String(req.headers['x-real-ip'] || '').trim();
    if (realIp) return realIp.slice(0, 64);
    return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
  }

  /**
   * Tags_code.link_qr se guarda con PROFILE_PUBLIC_BASE_URL al activar el perfil.
   * Si eso quedó en localhost y ahora hay un host público (túnel/LAN), el 302
   * no debe mandar el teléfono a 127.0.0.1.
   */
  private rewriteLoopbackTo(url: string, publicBase: string): string {
    try {
      const u = new URL(url);
      const b = new URL(publicBase);
      if (this.isLoopbackHost(u.hostname) && !this.isLoopbackHost(b.hostname)) {
        u.protocol = b.protocol;
        u.host = b.host;
        return u.toString();
      }
    } catch {
      /* URL inválida: se deja tal cual */
    }
    return url;
  }

  @Get()
  index() {
    return {
      name: 'tags-redirect-api',
      version: '1.5.0',
      route: 'GET /qr/:code y GET /nfc/:code',
      health: 'GET /health',
      ready: 'GET /ready',
    };
  }

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'redirectCode',
      ts: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const db = await this.security.pingDatabase();
    if (!db) {
      void this.security.recordEvent({
        kind: 'health',
        status: 'danger',
        message: 'GET /ready: MySQL no responde',
        data: { check: 'ready' },
      });
      throw new HttpException(
        { ok: false, db: false, message: 'database unavailable' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ok: true, db: true, limits: this.security.getLimits() };
  }

  /** Ruta corta del QR/NFC físico: dominio/qr|nfc/CODE */
  @Get('qr/:code')
  @Redirect()
  async redirectQr(
    @Param('code') code: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    return this.redirectTo(code, 'qr', userAgent, req);
  }

  @Get('nfc/:code')
  @Redirect()
  async redirectNfc(
    @Param('code') code: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    return this.redirectTo(code, 'nfc', userAgent, req);
  }

  /** Alias de tarjetas ya impresas: /redirect/qr|nfc/CODE */
  @Get('redirect/:type/:code')
  @Redirect()
  async redirectCanonical(
    @Param('type') type: string,
    @Param('code') code: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    return this.redirectTo(code, type, userAgent, req);
  }

  /** Alias legacy: /CODE/qr|nfc — mantener etiquetas ya impresas */
  @Get(':code/:type')
  @Redirect()
  async redirectLegacy(
    @Param('code') code: string,
    @Param('type') type: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    const c = String(code || '').toLowerCase();
    if (c === 'health' || c === 'ready') {
      return { url: `${this.appBase}/e/not-found`, statusCode: 302 };
    }
    if (c === 'qr' || c === 'nfc') {
      return this.redirectTo(type, c, userAgent, req);
    }
    return this.redirectTo(code, type, userAgent, req);
  }

  private redirectTo(
    code: string,
    type: string,
    userAgent: string | undefined,
    req: Request,
  ) {
    return this.resolveDestination(code, type, userAgent, this.clientIp(req)).then((url) => ({
      url,
      statusCode: 302,
    }));
  }

  private errorUrl(key: keyof typeof ERROR_PATHS): string {
    return `${this.appBase}${ERROR_PATHS[key]}`;
  }

  private loginIncompleteUrl(): string {
    return `${this.appBase}/login/?reason=profile_incomplete`;
  }

  private registerUrl(code: string): string {
    const q = `code=${encodeURIComponent(code)}&type=qr`;
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
    if (link) return this.rewriteLoopbackTo(link, this.profilePublicBase);
    const slug = String(tag.profile_slug ?? '').trim().replace(/^\/+/, '');
    if (!slug) return null;
    return `${this.profilePublicBase}/p/${encodeURIComponent(slug)}`;
  }

  private guardDestination(
    url: string,
    meta: { ip: string; userAgent?: string; code?: string; type?: string },
  ): string {
    const check = this.security.isDestinationAllowed(url);
    if (check.ok) return url;
    void this.security.recordAllowlistBlock({
      ip: meta.ip,
      userAgent: meta.userAgent,
      code: meta.code,
      type: meta.type,
      destination: url,
      host: check.host,
      reason: check.reason,
    });
    return this.errorUrl('unavailable');
  }

  private async resolveDestination(
    codeRaw: string,
    typeRaw: string,
    userAgent: string | undefined,
    ip: string,
  ): Promise<string> {
    const code = String(codeRaw ?? '').trim();
    const normalizedType = String(typeRaw ?? '')
      .trim()
      .toLowerCase() as SupportedType;
    const platform = TagsCodeService.platformFromUa(userAgent);

    const rate = this.security.checkRateLimit({
      ip,
      code,
      type: normalizedType,
      userAgent,
    });
    if (!rate.allowed) {
      return this.errorUrl('unavailable');
    }

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

    const meta = { ip, userAgent, code, type: normalizedType };

    if (normalizedType === 'nfc') {
      const url = this.resolveNfc(tag);
      const safe = this.guardDestination(url, meta);
      record(this.resultFromUrl(safe, tag), tag);
      return safe;
    }

    const url = this.resolveQr(tag);
    const safe = this.guardDestination(url, meta);
    record(this.resultFromUrl(safe, tag), tag);
    return safe;
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
      if (link) return this.rewriteLoopbackTo(link, this.profilePublicBase);
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
      return this.registerUrl(tag.code);
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
