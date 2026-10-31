export type InventorySource = 'EXTERNAL_B2B' | 'CHANNEL_MANAGER' | 'EXTRANET';

/** Why a stay can't be sold. Maps 1:1 to frontend messages. */
export type UnavailableReason =
  | 'SOLD_OUT'
  | 'NOT_LOADED' //      no inventory row for a night: treated as sold out, never as "unlimited"
  | 'NO_RATE' //         inventory exists but no price for a night
  | 'STOP_SELL'
  | 'MIN_LOS'
  | 'MAX_LOS'
  | 'CLOSED_TO_ARRIVAL'
  | 'CLOSED_TO_DEPARTURE'
  | 'ADVANCE_PURCHASE'; //  booked too early or too late for this rate's booking window

export interface NightQuote {
  date: string;
  availableRooms: number;
  priceMinor: number | null;
}

/** Normalised answer from any source, so the Live Ping logic is source-agnostic. */
export interface LiveInventory {
  source: InventorySource;
  available: boolean;
  /** Minimum rooms free across all nights (the bottleneck night decides). */
  availableRooms: number;
  /** Total for the whole stay for `rooms` rooms, in minor units. Null when not sellable. */
  totalPriceMinor: number | null;
  currency: string;
  nights: NightQuote[];
  reason?: UnavailableReason;
  reasonDetail?: string;
  /** Source 1 only: supplier's pre-book key and its expiry. */
  supplierBookingKey?: string | null;
  supplierExpiresAt?: Date | null;
  checkedAt: Date;
}
