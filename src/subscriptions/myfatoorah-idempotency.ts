export const MYFATOORAH_IDEMPOTENCY_WINDOW_MS = 250 * 60 * 1000;

const FIRST_REQUEST_KEYS = [
  'charge_first_requested_at',
  'charge_started_at',
  'payment_attempted_at',
  'charge_reservation_started_at',
] as const;

export function firstChargeRequestTimestamp(
  metadata: Record<string, unknown>,
): number | null {
  const explicit = metadata.charge_first_requested_at;
  if (typeof explicit === 'string') {
    const timestamp = Date.parse(explicit);
    if (Number.isFinite(timestamp)) return timestamp;
  }

  // Older code overwrote charge_started_at on every reclaim. Once a reclaim
  // has occurred without the immutable field, the real first request time is
  // unknowable and replay must fail closed.
  if (
    metadata.charge_reclaimed_at ||
    Number(metadata.charge_recovery_count) > 0
  ) {
    return null;
  }

  for (const key of FIRST_REQUEST_KEYS.slice(1)) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export function isInsideMyFatoorahIdempotencyWindow(
  metadata: Record<string, unknown>,
  now: Date,
): boolean {
  const firstRequestedAt = firstChargeRequestTimestamp(metadata);
  return (
    firstRequestedAt !== null &&
    now.getTime() - firstRequestedAt < MYFATOORAH_IDEMPOTENCY_WINDOW_MS
  );
}
