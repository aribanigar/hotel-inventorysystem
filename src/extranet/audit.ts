import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';

export type AuditAction = 'ARI_UPDATE' | 'RESERVATION_CREATE' | 'RESERVATION_STATUS';

/** Written inside the same transaction as the change it describes. */
export async function audit(
  client: PoolClient,
  entry: { hotelId: string; userId: string | null; action: AuditAction; summary: string; details?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    'INSERT INTO extranet_audit (hotel_id, user_id, action, summary, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [entry.hotelId, entry.userId, entry.action, entry.summary.slice(0, 500), JSON.stringify(entry.details ?? {})],
  );
}

export async function listAudit(db: Db, hotelId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.summary, a.details, a.created_at, u.name AS user_name
       FROM extranet_audit a LEFT JOIN hotel_users u ON u.id = a.user_id
      WHERE a.hotel_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [hotelId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}
