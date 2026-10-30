import { AppError } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const MAX_NIGHTS = 30;
export const MAX_ADVANCE_DAYS = 550;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Date math on whole UTC days, so DST and server time zone never matter. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The nights a guest occupies: checkIn inclusive, checkOut exclusive. */
export function stayNights(checkIn: string, checkOut: string): string[] {
  const n = daysBetween(checkIn, checkOut);
  return Array.from({ length: n }, (_, i) => addDays(checkIn, i));
}

/** Today's calendar date in the hotel's time zone (Kashmir hotels: Asia/Kolkata). */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Validates a stay; throws VALIDATION_ERROR with a precise reason. */
export function assertValidStay(checkIn: string, checkOut: string, timeZone = 'Asia/Kolkata'): string[] {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    throw new AppError('VALIDATION_ERROR', 'checkIn and checkOut must be YYYY-MM-DD dates');
  }
  const nights = daysBetween(checkIn, checkOut);
  if (nights < 1) throw new AppError('VALIDATION_ERROR', 'checkOut must be after checkIn');
  if (nights > MAX_NIGHTS) throw new AppError('VALIDATION_ERROR', `stays are limited to ${MAX_NIGHTS} nights`);
  const today = todayIn(timeZone);
  if (checkIn < today) throw new AppError('VALIDATION_ERROR', 'checkIn is in the past', { today });
  if (daysBetween(today, checkIn) > MAX_ADVANCE_DAYS) {
    throw new AppError('VALIDATION_ERROR', `checkIn is more than ${MAX_ADVANCE_DAYS} days ahead`);
  }
  return stayNights(checkIn, checkOut);
}
