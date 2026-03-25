import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';

type TagCodeRow = RowDataPacket & {
  code: string;
  status_qr: number;
  status_nfc: number;
  link_qr: string | null;
  link_nfc: string | null;
};

@Injectable()
export class TagsCodeService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly tableName = process.env.TAGS_TABLE_NAME ?? 'Tags_code';

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('Falta DATABASE_URL en variables de entorno.');
    }

    this.pool = createPool(databaseUrl);
  }

  async findByCode(code: string): Promise<TagCodeRow | null> {
    const query = `SELECT code, status_qr, status_nfc, link_qr, link_nfc FROM \`${this.tableName}\` WHERE code = ? LIMIT 1`;
    const [rows] = await this.pool.query<TagCodeRow[]>(query, [code]);
    return rows[0] ?? null;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
