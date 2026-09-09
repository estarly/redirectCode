import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';

export type TagResolveRow = RowDataPacket & {
  id: number;
  code: string;
  user_id: number | null;
  status_qr: number;
  status_nfc: number;
  link_qr: string | null;
  link_nfc: string | null;
  profile_status: number | null;
  profile_slug: string | null;
  profile_custom_domain: string | null;
};

export type ScanPlatform = 'ios' | 'android' | 'other';

@Injectable()
export class TagsCodeService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly tableName = process.env.TAGS_TABLE_NAME ?? 'Tags_code';
  private readonly profileTable = process.env.PROFILE_TABLE_NAME ?? 'Profile';
  private readonly scanTable = process.env.SCAN_EVENTS_TABLE_NAME ?? 'Scan_events';

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('Falta DATABASE_URL en variables de entorno.');
    }

    this.pool = createPool(databaseUrl);
  }

  async findByCodeWithProfile(code: string): Promise<TagResolveRow | null> {
    const query = `
      SELECT
        t.id,
        t.code,
        t.user_id,
        t.status_qr,
        t.status_nfc,
        t.link_qr,
        t.link_nfc,
        p.status AS profile_status,
        p.slug AS profile_slug,
        p.custom_domain AS profile_custom_domain
      FROM \`${this.tableName}\` t
      LEFT JOIN \`${this.profileTable}\` p ON p.user_id = t.user_id
      WHERE t.code = ?
      LIMIT 1
    `;
    const [rows] = await this.pool.query<TagResolveRow[]>(query, [code]);
    return rows[0] ?? null;
  }

  /**
   * Registra escaneo QR/NFC (conteo). No debe fallar el redirect si la tabla aún no existe.
   */
  async recordScanEvent(params: {
    code: string;
    type: 'qr' | 'nfc';
    result: string;
    ownerUserId?: number | null;
    tagId?: number | null;
    platform?: ScanPlatform;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO \`${this.scanTable}\`
          (\`code\`, \`type\`, \`platform\`, \`owner_user_id\`, \`tag_id\`, \`result\`, \`created_at\`)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
        [
          params.code,
          params.type,
          params.platform ?? 'other',
          params.ownerUserId ?? null,
          params.tagId ?? null,
          params.result,
        ],
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[redirectCode] No se pudo guardar Scan_events:', (err as Error)?.message);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async recordGatewayEvent(params: {
    kind: string;
    status: string;
    ip?: string | null;
    userAgent?: string | null;
    platform?: string | null;
    code?: string | null;
    type?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
  }): Promise<void> {
    const table = process.env.GATEWAY_EVENTS_TABLE_NAME ?? 'Gateway_events';
    try {
      await this.pool.query(
        `INSERT INTO \`${table}\`
          (\`kind\`, \`status\`, \`ip\`, \`user_agent\`, \`platform\`, \`code\`, \`type\`, \`message\`, \`data\`, \`created_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW(3))`,
        [
          String(params.kind || '').slice(0, 32),
          String(params.status || '').slice(0, 16),
          params.ip ? String(params.ip).slice(0, 64) : null,
          params.userAgent ? String(params.userAgent).slice(0, 512) : null,
          params.platform ? String(params.platform).slice(0, 32) : null,
          params.code ? String(params.code).slice(0, 64) : null,
          params.type ? String(params.type).slice(0, 16) : null,
          params.message ? String(params.message).slice(0, 255) : null,
          JSON.stringify(params.data ?? {}),
        ],
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[redirectCode] No se pudo guardar Gateway_events:',
        (err as Error)?.message,
      );
    }
  }

  static platformFromUa(uaRaw: string | undefined): ScanPlatform {
    const ua = String(uaRaw ?? '').toLowerCase();
    if (!ua) return 'other';
    if (/iphone|ipad|ipod|ios/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    return 'other';
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
