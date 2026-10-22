import {
  firstChargeRequestTimestamp,
  isInsideMyFatoorahIdempotencyWindow,
  MYFATOORAH_IDEMPOTENCY_WINDOW_MS,
} from './myfatoorah-idempotency';

describe('MyFatoorah idempotency window', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');

  it('allows replay only before the documented 250-minute boundary', () => {
    expect(
      isInsideMyFatoorahIdempotencyWindow(
        {
          charge_first_requested_at: new Date(
            now.getTime() - MYFATOORAH_IDEMPOTENCY_WINDOW_MS + 1,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isInsideMyFatoorahIdempotencyWindow(
        {
          charge_first_requested_at: new Date(
            now.getTime() - MYFATOORAH_IDEMPOTENCY_WINDOW_MS,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });

  it('fails closed for a legacy reclaimed attempt with no immutable timestamp', () => {
    expect(
      firstChargeRequestTimestamp({
        charge_started_at: '2026-07-29T11:00:00.000Z',
        charge_reclaimed_at: '2026-07-29T11:30:00.000Z',
        charge_recovery_count: 1,
      }),
    ).toBeNull();
  });
});
