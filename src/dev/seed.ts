/**
 * Seeds one hotel per inventory source with sample Kashmir data, plus a channel-manager
 * partner key. Prints the ids and the API key once; the key is stored only as a hash.
 *
 *   npm run migrate && npx tsx src/dev/seed.ts
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { addDays, todayIn } from '../lib/dates.js';

export interface SeedResult {
  partner: { id: string; apiKey: string; signingSecret: string };
  chain: { hotelId: string; roomTypeId: string };
  cmHotel: { hotelId: string; roomTypeId: string; ratePlanId: string; hotelCode: string; roomCode: string; rateCode: string };
  houseboat: { hotelId: string; roomTypeId: string; ratePlanId: string };
}

export async function seed(opts: { days?: number; allotment?: number; nightlyMinor?: number } = {}): Promise<SeedResult> {
  const { days = 60, allotment = 3, nightlyMinor = 850000 } = opts;
  const suffix = randomBytes(3).toString('hex'); // lets tests seed repeatedly
  const keyId = `ck_${suffix}`;
  const keySecret = randomBytes(24).toString('base64url');
  const signingSecret = randomBytes(32).toString('hex');
  const start = todayIn('Asia/Kolkata');
  const end = addDays(start, days - 1);

  return withTransaction(async (c) => {
    const partner = (
      await c.query(
        `INSERT INTO channel_partners (code, name, api_key_id, api_key_hash, signing_secret, require_signature)
         VALUES ($1, 'STAAH (sample)', $2, $3, $4, false) RETURNING id`,
        [`STAAH_${suffix}`, keyId, sha256Hex(keySecret), signingSecret],
      )
    ).rows[0].id;

    // Source 1: chain hotel via B2B supplier
    const chain = (
      await c.query(
        `INSERT INTO hotels (name, inventory_source, supplier_code, supplier_hotel_code, external_ref)
         VALUES ('Sample Chain Hotel Srinagar', 'EXTERNAL_B2B', 'TBO', $1, $2) RETURNING id`,
        [`TBO-SXR-${suffix}`, `chain-${suffix}`],
      )
    ).rows[0].id;
    const chainRoom = (
      await c.query(
        `INSERT INTO room_types (hotel_id, code, name, max_occupancy, supplier_room_code) VALUES ($1, 'DLX', 'Deluxe Lake View', 3, 'DLX-LV') RETURNING id`,
        [chain],
      )
    ).rows[0].id;

    // Source 2: mid-tier hotel managed by a channel manager
    const hotelCode = `STAAH-GMG-${suffix}`;
    const cm = (
      await c.query(
        `INSERT INTO hotels (name, inventory_source, channel_partner_id, cm_hotel_code, external_ref)
         VALUES ('Sample Hotel Gulmarg', 'CHANNEL_MANAGER', $1, $2, $3) RETURNING id`,
        [partner, hotelCode, `cm-${suffix}`],
      )
    ).rows[0].id;
    const cmRoom = (
      await c.query(
        `INSERT INTO room_types (hotel_id, code, name, max_occupancy, cm_room_code) VALUES ($1, 'SUP', 'Superior Room', 3, 'SUP') RETURNING id`,
        [cm],
      )
    ).rows[0].id;
    const cmRate = (
      await c.query(
        `INSERT INTO rate_plans (room_type_id, code, name, meal_plan, cm_rate_code, is_default) VALUES ($1, 'CP', 'Room + Breakfast', 'CP', 'CP', true) RETURNING id`,
        [cmRoom],
      )
    ).rows[0].id;

    // Source 3: offline houseboat in our extranet
    const hb = (
      await c.query(
        `INSERT INTO hotels (name, inventory_source, external_ref) VALUES ('Sample Houseboat Dal Lake', 'EXTRANET', $1) RETURNING id`,
        [`hb-${suffix}`],
      )
    ).rows[0].id;
    const hbRoom = (
      await c.query(`INSERT INTO room_types (hotel_id, code, name, max_occupancy) VALUES ($1, 'BED', 'Deluxe Bedroom', 3) RETURNING id`, [hb])
    ).rows[0].id;
    const hbRate = (
      await c.query(
        `INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default) VALUES ($1, 'MAP', 'Breakfast + Dinner', 'MAP', true) RETURNING id`,
        [hbRoom],
      )
    ).rows[0].id;

    // Inventory + rates for Sources 2 and 3.
    for (const [room, rate] of [
      [cmRoom, cmRate],
      [hbRoom, hbRate],
    ]) {
      await c.query(
        `INSERT INTO daily_inventory (room_type_id, stay_date, allotment)
         SELECT $1, d::date, $4 FROM generate_series($2::date, $3::date, interval '1 day') d`,
        [room, start, end, allotment],
      );
      await c.query(
        `INSERT INTO daily_rates (rate_plan_id, stay_date, price_minor)
         SELECT $1, d::date, $4 FROM generate_series($2::date, $3::date, interval '1 day') d`,
        [rate, start, end, nightlyMinor],
      );
    }

    return {
      partner: { id: partner, apiKey: `${keyId}.${keySecret}`, signingSecret },
      chain: { hotelId: chain, roomTypeId: chainRoom },
      cmHotel: { hotelId: cm, roomTypeId: cmRoom, ratePlanId: cmRate, hotelCode, roomCode: 'SUP', rateCode: 'CP' },
      houseboat: { hotelId: hb, roomTypeId: hbRoom, ratePlanId: hbRate },
    };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      console.log('\nStore the apiKey now: it is only kept as a hash.');
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
