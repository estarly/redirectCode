import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { TagsCodeService, type ScanPlatform } from './tags-code.service';

export type GatewayEventKind = 'rate_limit' | 'health' | 'allowlist';
export type GatewayEventStatus = 'warning' | 'danger';

type EventPayload = {
  kind: GatewayEventKind;
  status: GatewayEventStatus;
  ip?: string | null;
  userAgent?: string | null;
  platform?: ScanPlatform | null;
  code?: string | null;
  type?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
};

/**
 * Rate limit en memoria + escritura de Gateway_events (best-effort).
 */
@Injectable()
export class GatewaySecurityService implements OnModuleDestroy {
  private readonly perCodeLimit = Math.max(
    1,
    Number(process.env.RATE_LIMIT_PER_CODE ?? 30) || 30,
  );
  private readonly perIpLimit = Math.max(
    1,
    Number(process.env.RATE_LIMIT_PER_IP ?? 120) || 120,
  );
  private readonly windowMs = Math.max(
    10_000,
    Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000) || 60_000,
  );

  private readonly hits = new Map<string, number[]>();
  private readonly eventCooldown = new Map<string, number>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealthOk = true;

  constructor(private readonly tags: TagsCodeService) {
    const intervalMs = Math.max(
      30_000,
      Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 60_000) || 60_000,
    );
    this.healthTimer = setInterval(() => {
      void this.runBackgroundHealthCheck();
    }, intervalMs);
  }

  getLimits() {
    return {
      perCode: this.perCodeLimit,
      perIp: this.perIpLimit,
      windowMs: this.windowMs,
    };
  }

  /**
   * @returns true si la petición puede continuar
   */
  checkRateLimit(params: {
    ip: string;
    code: string;
    type: string;
    userAgent?: string;
  }): { allowed: boolean; reason?: string; count?: number; limit?: number } {
    const now = Date.now();
    const ip = params.ip || 'unknown';
    const code = String(params.code || '').trim() || 'unknown';
    const type = String(params.type || '').trim().toLowerCase() || 'qr';

    const codeKey = `code:${type}:${code}`;
    const ipKey = `ip:${ip}`;
    const codeCount = this.touch(codeKey, now);
    const ipCount = this.touch(ipKey, now);

    if (codeCount > this.perCodeLimit) {
      const status: GatewayEventStatus =
        codeCount > this.perCodeLimit * 2 ? 'danger' : 'warning';
      void this.recordEventThrottled(`rl:${codeKey}:${ip}`, {
        kind: 'rate_limit',
        status,
        ip,
        userAgent: params.userAgent,
        platform: TagsCodeService.platformFromUa(params.userAgent),
        code,
        type,
        message: `Rate limit por código (${codeCount}/${this.perCodeLimit})`,
        data: {
          scope: 'code',
          count: codeCount,
          limit: this.perCodeLimit,
          window_ms: this.windowMs,
          ip_count: ipCount,
        },
      });
      return {
        allowed: false,
        reason: 'code',
        count: codeCount,
        limit: this.perCodeLimit,
      };
    }

    if (ipCount > this.perIpLimit) {
      const status: GatewayEventStatus =
        ipCount > this.perIpLimit * 2 ? 'danger' : 'warning';
      void this.recordEventThrottled(`rl:${ipKey}`, {
        kind: 'rate_limit',
        status,
        ip,
        userAgent: params.userAgent,
        platform: TagsCodeService.platformFromUa(params.userAgent),
        code,
        type,
        message: `Rate limit por IP (${ipCount}/${this.perIpLimit})`,
        data: {
          scope: 'ip',
          count: ipCount,
          limit: this.perIpLimit,
          window_ms: this.windowMs,
        },
      });
      return {
        allowed: false,
        reason: 'ip',
        count: ipCount,
        limit: this.perIpLimit,
      };
    }

    return { allowed: true };
  }

  isDestinationAllowed(urlRaw: string): {
    ok: boolean;
    host?: string;
    reason?: string;
  } {
    const raw = String(urlRaw || '').trim();
    if (!raw) return { ok: false, reason: 'empty' };

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, host: parsed.hostname, reason: 'bad_scheme' };
    }

    const allowed = this.allowedHosts();
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (allowed.has(host)) return { ok: true, host };

    // En desarrollo permitir loopback si APP_BASE también es loopback
    if (this.isLoopback(host) && process.env.NODE_ENV !== 'production') {
      return { ok: true, host };
    }

    return { ok: false, host, reason: 'host_not_allowed' };
  }

  async recordAllowlistBlock(params: {
    ip: string;
    userAgent?: string;
    code?: string;
    type?: string;
    destination: string;
    host?: string;
    reason?: string;
  }) {
    await this.recordEventThrottled(
      `al:${params.ip}:${params.host || 'x'}`,
      {
        kind: 'allowlist',
        status: 'danger',
        ip: params.ip,
        userAgent: params.userAgent,
        platform: TagsCodeService.platformFromUa(params.userAgent),
        code: params.code,
        type: params.type,
        message: `Destino bloqueado por allowlist (${params.host || 'invalid'})`,
        data: {
          destination: String(params.destination || '').slice(0, 500),
          host: params.host || null,
          reason: params.reason || null,
        },
      },
    );
  }

  async pingDatabase(): Promise<boolean> {
    return this.tags.ping();
  }

  private async runBackgroundHealthCheck() {
    const ok = await this.pingDatabase();
    if (ok) {
      if (!this.lastHealthOk) {
        void this.recordEvent({
          kind: 'health',
          status: 'warning',
          message: 'Gateway recuperó conexión a MySQL',
          data: { recovered: true },
        });
      }
      this.lastHealthOk = true;
      return;
    }
    this.lastHealthOk = false;
    void this.recordEventThrottled('health:db_down', {
      kind: 'health',
      status: 'danger',
      message: 'Gateway sin señal a MySQL (/ready)',
      data: { check: 'background' },
    });
  }

  private touch(key: string, now: number): number {
    const windowStart = now - this.windowMs;
    const prev = this.hits.get(key) || [];
    const next = prev.filter((t) => t >= windowStart);
    next.push(now);
    this.hits.set(key, next);
    // limpieza ocasional
    if (this.hits.size > 5000) {
      for (const [k, arr] of this.hits) {
        const kept = arr.filter((t) => t >= windowStart);
        if (!kept.length) this.hits.delete(k);
        else this.hits.set(k, kept);
      }
    }
    return next.length;
  }

  private allowedHosts(): Set<string> {
    const hosts = new Set<string>();
    const addFromBase = (value?: string) => {
      const raw = String(value || '').trim();
      if (!raw) return;
      try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        hosts.add(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
      } catch {
        /* ignore */
      }
    };
    addFromBase(process.env.APP_BASE_URL);
    addFromBase(process.env.PROFILE_PUBLIC_BASE_URL);
    addFromBase(process.env.REDIRECT_FALLBACK_BASE);
    const extra = String(process.env.REDIRECT_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    for (const h of extra) hosts.add(h.replace(/^\[|\]$/g, ''));
    return hosts;
  }

  private isLoopback(host: string): boolean {
    const h = host.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }

  private async recordEventThrottled(key: string, payload: EventPayload) {
    const now = Date.now();
    const cooldown = Math.max(
      15_000,
      Number(process.env.GATEWAY_EVENT_COOLDOWN_MS ?? 60_000) || 60_000,
    );
    const last = this.eventCooldown.get(key) || 0;
    if (now - last < cooldown) return;
    this.eventCooldown.set(key, now);
    await this.recordEvent(payload);
  }

  async recordEvent(payload: EventPayload): Promise<void> {
    await this.tags.recordGatewayEvent(payload);
  }

  onModuleDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }
}
