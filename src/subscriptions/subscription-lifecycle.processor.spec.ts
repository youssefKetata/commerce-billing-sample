import { Logger } from '@nestjs/common';
import { Invoice, Payment, PaymentToken, Subscription } from '@commerce/database';
import { DataSource, Repository } from 'typeorm';
import { SubscriptionLifecycleProcessor } from './subscription-lifecycle.processor';

function createSelectQueryBuilder<T>(options?: {
  one?: T | null;
  raw?: Array<{ id: number | string }>;
}) {
  return {
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(options?.one ?? null),
    getRawMany: jest.fn().mockResolvedValue(options?.raw ?? []),
    innerJoin: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };
}

function createDynamicSelectQueryBuilder<T>(getOne: () => T | null) {
  return {
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockImplementation(async () => getOne()),
    getRawMany: jest.fn().mockResolvedValue([]),
    innerJoin: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };
}

function createUpdateQueryBuilder() {
  return {
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    set: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };
}

type ProcessorInternals = {
  applyCancellationIfDue(subscriptionId: number): Promise<boolean>;
  applyPendingPlanIfDue(subscriptionId: number): Promise<boolean>;
  processRenewalIfDue(subscriptionId: number): Promise<{
    prepared: boolean;
    charged: boolean;
    paid: boolean;
    actionRequired: boolean;
    failed: boolean;
  }>;
  prepareRenewalChargeAttemptIfDue(subscriptionId: number): Promise<unknown>;
  finalizeRenewalChargeOutcome(
    paymentId: number,
    outcome: {
      status: 'paid' | 'requires_action' | 'failed';
      message: string;
      gatewayPaymentId: string | null;
      gatewayInvoiceId: string | null;
      gatewayTransactionId: string | null;
      paymentUrl: string | null;
      metadata: Record<string, unknown>;
    },
  ): Promise<unknown>;
  findDueCancellationIds(now: Date): Promise<number[]>;
  findDuePendingPlanIds(now: Date): Promise<number[]>;
  findDueRenewalIds(now: Date): Promise<number[]>;
};

function getInternals(
  processor: SubscriptionLifecycleProcessor,
): ProcessorInternals {
  return processor as unknown as ProcessorInternals;
}

function createProcessor(
  subscriptionRepository: Partial<Repository<Subscription>>,
  getRepository?: jest.Mock,
  options?: {
    billingRecoveryService?: {
      enqueuePaymentRecoveryIssue?: jest.Mock;
      flushPendingStoreGoAction: jest.Mock;
      notifyPaymentRecoveryIssue?: jest.Mock;
      suspendStoreForCancelledSubscription: jest.Mock;
      suspendStoreForInvalidBillingConfiguration?: jest.Mock;
    };
    createPaymentV3?: jest.Mock;
    getPaymentV3?: jest.Mock;
    resolveConfig?: jest.Mock;
  },
) {
  const transaction = jest.fn(
    async (work: (manager: { getRepository: jest.Mock }) => Promise<unknown>) =>
      work({ getRepository: getRepository ?? jest.fn() }),
  );
  const dataSource = { transaction } as unknown as DataSource;
  const myFatoorahClient = {
    createPaymentV3:
      options?.createPaymentV3 ??
      jest.fn().mockResolvedValue({
        IsSuccess: true,
        Data: {
          PaymentCompleted: true,
          PaymentId: 'pay-1',
          TransactionDetails: {
            Invoice: { Status: 'PAID' },
            Transaction: { Status: 'SUCCESS' },
          },
        },
      }),
    getPaymentV3:
      options?.getPaymentV3 ??
      jest.fn().mockResolvedValue({
        IsSuccess: true,
        Data: {
          Invoice: { Status: 'PAID' },
          Transaction: { Status: 'SUCCESS' },
        },
      }),
  };
  const myFatoorahConfigService = {
    resolveForPaymentInitiation:
      options?.resolveConfig ??
      jest.fn().mockResolvedValue({
        apiBaseUrl: 'https://example.test',
        apiToken: 'api-secret',
        environment: 'test',
      }),
  };
  return {
    myFatoorahClient,
    myFatoorahConfigService,
    processor: new SubscriptionLifecycleProcessor(
      subscriptionRepository as Repository<Subscription>,
      dataSource,
      myFatoorahClient as never,
      myFatoorahConfigService as never,
      options?.billingRecoveryService as never,
    ),
    transaction,
  };
}

function createRenewalProcessHarness(options?: {
  billingRecoveryService?: {
    enqueuePaymentRecoveryIssue?: jest.Mock;
    flushPendingStoreGoAction: jest.Mock;
    notifyPaymentRecoveryIssue?: jest.Mock;
    suspendStoreForCancelledSubscription: jest.Mock;
    suspendStoreForInvalidBillingConfiguration?: jest.Mock;
  };
  billingCycle?: string | null;
  createPaymentV3?: jest.Mock;
  existingInvoice?: Invoice | null;
  existingOpenPayment?: Payment | null;
  plan?: Record<string, unknown>;
  paymentToken?: PaymentToken | null;
}) {
  const periodStart = new Date('2026-06-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-01T00:00:00.000Z');
  const paymentToken =
    options?.paymentToken === undefined
      ? ({
          id: 81,
          user_id: 7,
          provider: 'myfatoorah',
          token_or_ref: 'TKN-renewal',
          is_default: true,
          metadata: { brand: 'Visa', last4: '1019' },
        } as PaymentToken)
      : options.paymentToken;
  const subscription = {
    id: 13,
    store_id: 11,
    status: 'active',
    billing_cycle:
      options && 'billingCycle' in options ? options.billingCycle : 'monthly',
    current_period_start: new Date('2026-05-01T00:00:00.000Z'),
    current_period_end: periodStart,
    cancel_at_period_end: false,
    store: { id: 11, user_id: 7 },
    plan: {
      id: 3,
      slug: 'growth',
      name_en: 'Growth',
      name_ar: 'Growth',
      price_monthly: 49,
      price_yearly: 499,
      currency: 'KWD',
      features_en: [],
      features_ar: [],
      limits: {},
      ...options?.plan,
    },
  } as Subscription;
  const invoice =
    options?.existingInvoice ??
    ({
      id: 41,
      user_id: 7,
      store_id: 11,
      subscription_id: subscription.id,
      invoice_type: 'renewal',
      currency: 'KWD',
      amount: 49,
      status: 'pending',
      period_start: periodStart,
      period_end: periodEnd,
    } as Invoice);
  let payment =
    options?.existingOpenPayment ??
    ({
      id: 51,
      invoice_id: invoice.id,
      user_id: 7,
      store_id: 11,
      amount: 49,
      currency: 'KWD',
      status: 'pending',
      attempt_source: 'automatic_renewal',
      payment_token_id: paymentToken?.id ?? null,
      metadata: {},
    } as Payment);
  const subscriptionRepository = {
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(createSelectQueryBuilder({ one: subscription })),
    save: jest.fn(async (payload) => payload),
  };
  const invoiceRepository = {
    findOne: jest.fn().mockResolvedValue(options?.existingInvoice ?? null),
    create: jest.fn((payload: Partial<Invoice>) =>
      Object.assign(invoice, payload),
    ),
    save: jest.fn(async (payload: Invoice) => {
      Object.assign(invoice, payload);
      return { ...invoice } as Invoice;
    }),
    update: jest.fn().mockImplementation(async (_criteria, changes) => {
      Object.assign(invoice, changes);
      return { affected: 1 };
    }),
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(createDynamicSelectQueryBuilder(() => invoice)),
  };
  const paymentRepository = {
    findOne: jest.fn().mockResolvedValue(options?.existingOpenPayment ?? null),
    create: jest.fn((payload: Partial<Payment>) => ({ id: 51, ...payload })),
    save: jest.fn(async (payload: Payment) => {
      payment = { ...payment, ...payload } as Payment;
      return { ...payment } as Payment;
    }),
    createQueryBuilder: jest
      .fn()
      .mockReturnValue(createDynamicSelectQueryBuilder(() => payment)),
  };
  const paymentTokenRepository = {
    findOne: jest.fn().mockResolvedValue(paymentToken),
  };
  const getRepository = jest.fn((entity) => {
    if (entity === Subscription) return subscriptionRepository;
    if (entity === Invoice) return invoiceRepository;
    if (entity === Payment) return paymentRepository;
    if (entity === PaymentToken) return paymentTokenRepository;
    throw new Error('Unexpected repository');
  });
  const createPaymentV3 =
    options?.createPaymentV3 ??
    jest.fn().mockResolvedValue({
      IsSuccess: true,
      Data: {
        PaymentCompleted: true,
        PaymentId: 'mf-payment-1',
        InvoiceId: 'mf-invoice-1',
        TransactionDetails: {
          Invoice: { Status: 'PAID' },
          Transaction: { Status: 'SUCCESS' },
        },
      },
    });
  const harness = createProcessor({}, getRepository, {
    billingRecoveryService: options?.billingRecoveryService,
    createPaymentV3,
  });

  return {
    ...harness,
    createPaymentV3,
    invoice,
    payment: () => payment,
    paymentRepository,
    paymentToken,
    subscription,
  };
}

describe('SubscriptionLifecycleProcessor', () => {
  it('keeps success terminal across repeated late non-paid worker events', async () => {
    const { invoice, payment, processor, subscription } =
      createRenewalProcessHarness();
    payment().status = 'paid';
    invoice.status = 'paid';
    subscription.status = 'active';

    for (const status of ['requires_action', 'failed'] as const) {
      await expect(
        getInternals(processor).finalizeRenewalChargeOutcome(payment().id, {
          status,
          message: `late ${status}`,
          gatewayPaymentId: null,
          gatewayInvoiceId: null,
          gatewayTransactionId: null,
          paymentUrl: null,
          metadata: {},
        }),
      ).resolves.toEqual(expect.objectContaining({ paid: true }));
    }

    expect(payment().status).toBe('paid');
    expect(invoice.status).toBe('paid');
    expect(subscription.status).toBe('active');
  });

  it('does not repost an uncertain renewal after MyFatoorah idempotency expires', async () => {
    const expiredRequestAt = new Date(Date.now() - 251 * 60 * 1000);
    const existingOpenPayment = {
      id: 51,
      invoice_id: 41,
      status: 'pending',
      attempt_source: 'automatic_renewal',
      payment_token_id: 81,
      metadata: {
        charge_first_requested_at: expiredRequestAt.toISOString(),
        charge_started_at: expiredRequestAt.toISOString(),
        charge_reservation_started_at: expiredRequestAt.toISOString(),
        idempotency_key: 'renewal-payment-51',
      },
    } as Payment;
    const createPaymentV3 = jest.fn();
    const { payment, processor, subscription } = createRenewalProcessHarness({
      createPaymentV3,
      existingOpenPayment,
    });

    await expect(
      getInternals(processor).processRenewalIfDue(subscription.id),
    ).resolves.toEqual(
      expect.objectContaining({
        charged: false,
        paid: false,
        failed: false,
      }),
    );

    expect(createPaymentV3).not.toHaveBeenCalled();
    expect(payment()).toMatchObject({
      status: 'pending',
      attempt_source: 'automatic_renewal',
      failure_reason: expect.stringContaining('uncertain'),
      metadata: expect.objectContaining({
        charge_state: 'uncertain',
        authoritative_reconciliation_required: true,
        charge_first_requested_at: expiredRequestAt.toISOString(),
      }),
    });
  });

  it('reconciles a stale attempt by PaymentId instead of posting it again', async () => {
    const staleReservationAt = new Date(Date.now() - 31 * 60 * 1000);
    const existingOpenPayment = {
      id: 51,
      invoice_id: 41,
      status: 'pending',
      attempt_source: 'automatic_renewal',
      payment_token_id: 81,
      gateway_payment_id: 'mf-existing-payment',
      metadata: {
        charge_first_requested_at: new Date(
          Date.now() - 251 * 60 * 1000,
        ).toISOString(),
        charge_started_at: staleReservationAt.toISOString(),
        charge_reservation_started_at: staleReservationAt.toISOString(),
        idempotency_key: 'renewal-payment-51',
      },
    } as Payment;
    const createPaymentV3 = jest.fn();
    const { myFatoorahClient, payment, processor, subscription } =
      createRenewalProcessHarness({
        createPaymentV3,
        existingOpenPayment,
      });

    await expect(
      getInternals(processor).processRenewalIfDue(subscription.id),
    ).resolves.toEqual(expect.objectContaining({ paid: true }));

    expect(createPaymentV3).not.toHaveBeenCalled();
    expect(myFatoorahClient.getPaymentV3).toHaveBeenCalledWith(
      'https://example.test',
      'api-secret',
      'mf-existing-payment',
    );
    expect(payment().status).toBe('paid');
  });
});
