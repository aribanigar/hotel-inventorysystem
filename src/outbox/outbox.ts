/**
 * Transactional outbox.
 *
 * Problem: when inventory changes we must tell other channels (the hotel's channel
 * manager, partner OTAs/websites). If we call them directly inside the request and the
 * call fails, or the process dies after COMMIT but before the call, channels drift out
 * of sync and overbookings follow.
 *
 * Fix: write the "tell channel X" event into ari_outbox in the SAME transaction as the
 * inventory change. Both commit together or neither does. A worker then delivers the
 * events with retries (see worker.ts).
 */
import type { PoolClient } from 'pg';

export type OutboxEvent = 'ARI_CHANGED' | 'RESERVATION_CREATED' | 'SUPPLIER_BOOK' | 'QLO_ARI_PUSH';

/**
 * Fans out one outbox row per active subscription of the hotel that wants this event.
 * ARI changes also queue a push to the hotel's channel-manager account, if linked.
 */
export async function enqueueForSubscribers(
  client: PoolClient,
  hotelId: string,
  event: 'ARI_CHANGED' | 'RESERVATION_CREATED',
  payload: Record<string, unknown>,
): Promise<number> {
  const json = JSON.stringify(payload);
  const { rowCount } = await client.query(
    `INSERT INTO ari_outbox (event_type, hotel_id, subscription_id, payload)
     SELECT $2, $1, s.id, $3::jsonb
       FROM channel_subscriptions s
      WHERE s.hotel_id = $1 AND s.is_active AND $2 = ANY (s.event_types)`,
    [hotelId, event, json],
  );
  let n = rowCount ?? 0;
  if (event === 'ARI_CHANGED') {
    const cm = await client.query(
      `INSERT INTO ari_outbox (event_type, hotel_id, payload)
       SELECT 'QLO_ARI_PUSH', h.id, $2::jsonb
         FROM hotels h JOIN cm_accounts a ON a.id = h.cm_account_id
        WHERE h.id = $1 AND a.push_enabled`,
      [hotelId, json],
    );
    n += cm.rowCount ?? 0;
  }
  return n;
}

/** Internal job not tied to a subscription (e.g. finalise a supplier booking). */
export async function enqueueJob(
  client: PoolClient,
  hotelId: string,
  event: 'SUPPLIER_BOOK',
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`INSERT INTO ari_outbox (event_type, hotel_id, payload) VALUES ($1, $2, $3::jsonb)`, [
    event,
    hotelId,
    JSON.stringify(payload),
  ]);
}
