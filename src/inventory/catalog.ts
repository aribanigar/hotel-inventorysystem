import type { Db } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import type { InventorySource } from './types.js';

export interface SellableProduct {
  hotelId: string;
  hotelName: string;
  source: InventorySource;
  timezone: string;
  currency: string;
  supplierCode: string | null;
  supplierHotelCode: string | null;
  roomTypeId: string;
  roomName: string;
  maxOccupancy: number;
  supplierRoomCode: string | null;
  ratePlanId: string | null;
}

/**
 * Resolves hotel + room type (+ rate plan) in one query and proves they belong
 * together. A client sending a room id from hotel A with hotel id B is rejected here,
 * before any inventory logic runs.
 *
 * If ratePlanId is omitted the room's default rate plan is used.
 */
export async function loadSellableProduct(
  db: Db,
  hotelId: string,
  roomTypeId: string,
  ratePlanId?: string | null,
): Promise<SellableProduct> {
  const { rows } = await db.query(
    `SELECT h.id AS hotel_id, h.name AS hotel_name, h.inventory_source AS source, h.timezone, h.currency,
            h.supplier_code, h.supplier_hotel_code,
            rt.id AS room_type_id, rt.name AS room_name, rt.max_occupancy, rt.supplier_room_code,
            rp.id AS rate_plan_id
       FROM hotels h
       JOIN room_types rt ON rt.hotel_id = h.id AND rt.id = $2 AND rt.is_active
       LEFT JOIN LATERAL (
              SELECT id FROM rate_plans
               WHERE room_type_id = rt.id AND is_active
                 AND ($3::uuid IS NULL AND is_default OR id = $3::uuid)
               LIMIT 1
            ) rp ON true
      WHERE h.id = $1 AND h.is_active`,
    [hotelId, roomTypeId, ratePlanId ?? null],
  );
  const r = rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Hotel or room type not found', { hotelId, roomTypeId });

  // Our own inventory sources must have a rate plan to price from. Source 1 is priced by the supplier.
  if (r.source !== 'EXTERNAL_B2B' && !r.rate_plan_id) {
    throw new AppError('NOT_FOUND', ratePlanId ? 'Rate plan not found for this room' : 'Room has no default rate plan', {
      roomTypeId,
      ratePlanId,
    });
  }

  return {
    hotelId: r.hotel_id,
    hotelName: r.hotel_name,
    source: r.source,
    timezone: r.timezone,
    currency: r.currency.trim(),
    supplierCode: r.supplier_code,
    supplierHotelCode: r.supplier_hotel_code,
    roomTypeId: r.room_type_id,
    roomName: r.room_name,
    maxOccupancy: r.max_occupancy,
    supplierRoomCode: r.supplier_room_code,
    ratePlanId: r.rate_plan_id,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
