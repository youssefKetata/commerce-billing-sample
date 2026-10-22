import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  addBillingCycle,
  billingGraceEndsAt,
  type BillingCycle,
  Invoice,
  Payment,
  PaymentToken,
  Subscription,
} from '@commerce/database';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  voidMalformedPendingRenewalInvoice,
  voidOpenBillingRecordsForSubscription,
} from './subscription-billing-cleanup';
import {
  MyFatoorahClientService,
  MyFatoorahEnvelope,
} from '../payments/myfatoorah/myfatoorah-client.service';
import {
  MyFatoorahConfig,
  MyFatoorahConfigService,
} from '../payments/myfatoorah/myfatoorah-config.service';
import { resolveStructuredMyFatoorahPaymentStatus } from '../payments/myfatoorah-payment-status';
import { SubscriptionBillingRecoveryService } from './subscription-billing-recovery.service';
import {
  firstChargeRequestTimestamp,
  isInsideMyFatoorahIdempotencyWindow,
} from './myfatoorah-idempotency';

export type SubscriptionLifecycleBatchSummary = {
  cancellationCandidates: number;
  cancellationsApplied: number;
  pendingPlanCandidates: number;
  pendingPlansApplied: number;
  renewalCandidates: number;
  renewalsPrepared: number;
  renewalsCharged: number;
  renewalsPaid: number;
  renewalsActionRequired: number;
  renewalsFailed: number;
  recoveryCandidates: number;
  recoveryRetried: number;
  recoveryPaid: number;
  recoveryActionRequired: number;
  recoveryFailed: number;
  recoveryExpired: number;
  recoveryEmailsSent: number;
  recoveryEmailFailures: number;
  failures: number;
};

type RenewalProcessResult = {
  prepared: boolean;
  charged: boolean;
  paid: boolean;
  actionRequired: boolean;
  failed: boolean;
};

type PreparedRenewalCharge = {
  paymentId: number;
  invoiceId: number | null;
  subscriptionId: number;
  tenantId: number;
  storeId: number;
  amount: number;
  currency: string;
  paymentToken: PaymentToken | null;
  idempotencyKey: string;
  paymentExpiry?: string;
  prepared: boolean;
  failedWithoutCharge?: boolean;
  paidWithoutCharge?: boolean;
  suspendedStoreId?: number;
  gatewayPaymentId?: string;
};

type RenewalAmountResult =
  | {
      valid: true;
      amount: number;
    }
  | {
      valid: false;
      amount: 0;
      failureReason: string;
      rawAmount: unknown;
    };

type RenewalChargeOutcome = {
  status: 'paid' | 'requires_action' | 'failed';
  message: string;
  gatewayPaymentId: string | null;
  gatewayInvoiceId: string | null;
  gatewayTransactionId: string | null;
  paymentUrl: string | null;
  metadata: Record<string, unknown>;
};

const CHARGE_RESERVATION_TIMEOUT_MS = 30 * 60 * 1000;
const SUBSCRIPTION_LIFECYCLE_BATCH_SIZE = 100;

@Injectable()
export class SubscriptionLifecycleProcessor {
  private readonly logger = new Logger(SubscriptionLifecycleProcessor.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    private readonly dataSource: DataSource,
    private readonly myFatoorahClient: MyFatoorahClientService,
    private readonly myFatoorahConfigService: MyFatoorahConfigService,
    private readonly billingRecoveryService?: SubscriptionBillingRecoveryService,
  ) {}

  async processDueTransitions(): Promise<SubscriptionLifecycleBatchSummary> {
    const now = new Date();
    const cancellationIds = await this.findDueCancellationIds(now);
    const summary: SubscriptionLifecycleBatchSummary = {
      cancellationCandidates: cancellationIds.length,
      cancellationsApplied: 0,
      pendingPlanCandidates: 0,
      pendingPlansApplied: 0,
      renewalCandidates: 0,
      renewalsPrepared: 0,
      renewalsCharged: 0,
      renewalsPaid: 0,
      renewalsActionRequired: 0,
      renewalsFailed: 0,
      recoveryCandidates: 0,
      recoveryRetried: 0,
      recoveryPaid: 0,
      recoveryActionRequired: 0,
      recoveryFailed: 0,
      recoveryExpired: 0,
      recoveryEmailsSent: 0,
      recoveryEmailFailures: 0,
      failures: 0,
    };

    for (const subscriptionId of cancellationIds) {
      try {
        if (await this.applyCancellationIfDue(subscriptionId)) {
          summary.cancellationsApplied += 1;
        }
      } catch (error) {
        summary.failures += 1;
        this.logTransitionFailure('cancellation', subscriptionId, error);
      }
    }

    const pendingPlanIds = await this.findDuePendingPlanIds(now);
    summary.pendingPlanCandidates = pendingPlanIds.length;
    for (const subscriptionId of pendingPlanIds) {
      try {
        if (await this.applyPendingPlanIfDue(subscriptionId)) {
          summary.pendingPlansApplied += 1;
        }
      } catch (error) {
        summary.failures += 1;
        this.logTransitionFailure('pending-plan', subscriptionId, error);
      }
    }

    const renewalIds = await this.findDueRenewalIds(now);
    summary.renewalCandidates = renewalIds.length;
    for (const subscriptionId of renewalIds) {
      try {
        const result = await this.processRenewalIfDue(subscriptionId);
        if (result.prepared) {
          summary.renewalsPrepared += 1;
        }
        if (result.charged) {
          summary.renewalsCharged += 1;
        }
        if (result.paid) {
          summary.renewalsPaid += 1;
        }
        if (result.actionRequired) {
          summary.renewalsActionRequired += 1;
        }
        if (result.failed) {
          summary.renewalsFailed += 1;
        }
      } catch (error) {
        summary.failures += 1;
        this.logTransitionFailure('renewal', subscriptionId, error);
      }
    }

    if (this.billingRecoveryService) {
      try {
        const recoverySummary =
          await this.billingRecoveryService.processPastDueRecoveries(now);
        summary.recoveryCandidates = recoverySummary.recoveryCandidates;
        summary.recoveryRetried = recoverySummary.recoveryRetried;
        summary.recoveryPaid = recoverySummary.recoveryPaid;
        summary.recoveryActionRequired = recoverySummary.recoveryActionRequired;
        summary.recoveryFailed = recoverySummary.recoveryFailed;
        summary.recoveryExpired = recoverySummary.recoveryExpired;
        summary.recoveryEmailsSent = recoverySummary.recoveryEmailsSent;
        summary.recoveryEmailFailures = recoverySummary.recoveryEmailFailures;
      } catch (error) {
        summary.failures += 1;
        this.logger.error('Failed to process billing recovery lane', error);
      }
    }

    return summary;
  }

  private findDueCancellationIds(now: Date): Promise<number[]> {
    return this.findDueIds(
      this.subscriptionRepository
        .createQueryBuilder('subscription')
        .where('subscription.cancel_at_period_end = :cancelAtPeriodEnd', {
          cancelAtPeriodEnd: true,
        })
        .andWhere('subscription.current_period_end IS NOT NULL')
        .andWhere('subscription.current_period_end <= :now', { now })
        .andWhere('subscription.status NOT IN (:...terminalStatuses)', {
          terminalStatuses: ['cancelled', 'expired'],
        }),
    );
  }

  private findDuePendingPlanIds(now: Date): Promise<number[]> {
    return this.findDueIds(
      this.subscriptionRepository
        .createQueryBuilder('subscription')
        .innerJoin('subscription.store', 'store')
        .where('subscription.pending_plan_id IS NOT NULL')
        .andWhere('subscription.cancel_at_period_end = :cancelAtPeriodEnd', {
          cancelAtPeriodEnd: false,
        })
        .andWhere('subscription.current_period_end IS NOT NULL')
        .andWhere('subscription.current_period_end <= :now', { now })
        .andWhere('subscription.status IN (:...renewableStatuses)', {
          renewableStatuses: ['active', 'trialing'],
        })
        .andWhere('store.deleted_at IS NULL'),
    );
  }

  private findDueRenewalIds(now: Date): Promise<number[]> {
    return this.findDueIds(
      this.subscriptionRepository
        .createQueryBuilder('subscription')
        .innerJoin('subscription.store', 'store')
        .where('subscription.cancel_at_period_end = :cancelAtPeriodEnd', {
          cancelAtPeriodEnd: false,
        })
        .andWhere('subscription.current_period_end IS NOT NULL')
        .andWhere('subscription.current_period_end <= :now', { now })
        .andWhere(
          `(
            subscription.status = :activeStatus
            OR (
              subscription.status = :trialingStatus
              AND subscription.trial_ends_at IS NOT NULL
              AND subscription.trial_ends_at <= :now
            )
          )`,
          {
            activeStatus: 'active',
            trialingStatus: 'trialing',
            now,
          },
        )
        .andWhere('store.deleted_at IS NULL'),
    );
  }

  private async findDueIds(
    queryBuilder: ReturnType<Repository<Subscription>['createQueryBuilder']>,
  ): Promise<number[]> {
    const rows = await queryBuilder
      .select('subscription.id', 'id')
      .orderBy('subscription.current_period_end', 'ASC')
      .addOrderBy('subscription.id', 'ASC')
      .limit(SUBSCRIPTION_LIFECYCLE_BATCH_SIZE)
      .getRawMany<{ id: number | string }>();

    return rows.map((row) => Number(row.id)).filter(Number.isFinite);
  }

  private async applyCancellationIfDue(
    subscriptionId: number,
  ): Promise<boolean> {
    const result = await this.dataSource.transaction(async (manager) => {
      const subscriptionRepository = manager.getRepository(Subscription);
      const invoiceRepository = manager.getRepository(Invoice);
      const paymentRepository = manager.getRepository(Payment);
      const subscription = await subscriptionRepository
        .createQueryBuilder('subscription')
        .setLock('pessimistic_write', undefined, ['subscription'])
        .leftJoinAndSelect('subscription.pending_plan', 'pending_plan')
        .where('subscription.id = :subscriptionId', { subscriptionId })
        .getOne();

      if (!subscription || !this.isCancellationDue(subscription, new Date())) {
        return { applied: false, pausedStoreId: null };
      }

      const effectiveAt = subscription.current_period_end;
      subscription.status = 'cancelled';
      subscription.cancelled_at = effectiveAt;
      subscription.cancel_at_period_end = false;
      subscription.pending_plan_id = null;
      subscription.pending_plan = null;
      await subscriptionRepository.save(subscription);

      await voidOpenBillingRecordsForSubscription(
        invoiceRepository,
        paymentRepository,
        subscription.id,
        `Voided at scheduled cancellation apply for subscription ${subscription.id}`,
      );

      const pausedStoreId = this.billingRecoveryService
        ? await this.billingRecoveryService.suspendStoreForCancelledSubscription(
            manager,
            subscription,
          )
        : null;
      return { applied: true, pausedStoreId };
    });
    if (result.pausedStoreId) {
      await this.billingRecoveryService?.flushPendingStoreGoAction(
        result.pausedStoreId,
      );
    }
    return result.applied;
  }

  private applyPendingPlanIfDue(subscriptionId: number): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const subscriptionRepository = manager.getRepository(Subscription);
      const subscription = await subscriptionRepository
        .createQueryBuilder('subscription')
        .setLock('pessimistic_write', undefined, ['subscription'])
        .innerJoinAndSelect('subscription.store', 'store')
        .leftJoinAndSelect('subscription.pending_plan', 'pending_plan')
        .where('subscription.id = :subscriptionId', { subscriptionId })
        .andWhere('store.deleted_at IS NULL')
        .getOne();

      const pendingPlan = subscription?.pending_plan;
      if (
        !subscription ||
        !pendingPlan ||
        !this.isPendingPlanDue(subscription, new Date())
      ) {
        return false;
      }

      subscription.plan_id = pendingPlan.id;
      subscription.plan = pendingPlan;
      subscription.pending_plan_id = null;
      subscription.pending_plan = null;
      await subscriptionRepository.save(subscription);

      return true;
    });
  }

  private async processRenewalIfDue(
    subscriptionId: number,
  ): Promise<RenewalProcessResult> {
    const prepared =
      await this.prepareRenewalChargeAttemptIfDue(subscriptionId);
    if (!prepared) {
      return this.emptyRenewalResult();
    }
    if (prepared.suspendedStoreId && this.billingRecoveryService) {
      await this.billingRecoveryService.flushPendingStoreGoAction(
        prepared.suspendedStoreId,
      );
    }

    const result: RenewalProcessResult = {
      ...this.emptyRenewalResult(),
      prepared: prepared.prepared,
      failed: prepared.failedWithoutCharge === true,
    };
    if (prepared.paidWithoutCharge) {
      return {
        ...result,
        paid: true,
      };
    }
    if (prepared.failedWithoutCharge || !prepared.paymentToken) {
      if (result.failed && prepared.invoiceId != null) {
        await this.notifyRecoveryIssueSafely(prepared.paymentId);
      }
      return result;
    }
    if (prepared.invoiceId == null) {
      return result;
    }
    const invoiceId = prepared.invoiceId;

    let config: MyFatoorahConfig;
    try {
      config = await this.myFatoorahConfigService.resolveForPaymentInitiation();
    } catch (error) {
      this.logger.error(
        `Skipping renewal charge because MyFatoorah configuration is unavailable: ${
          error instanceof Error ? error.message : 'unknown configuration error'
        }`,
      );
      return result;
    }
    if (prepared.gatewayPaymentId) {
      try {
        const response = await this.myFatoorahClient.getPaymentV3(
          config.apiBaseUrl,
          config.apiToken,
          prepared.gatewayPaymentId,
        );
        const outcome = this.resolveRenewalChargeOutcome(response);
        const finalized = await this.finalizeRenewalChargeOutcome(
          prepared.paymentId,
          {
            ...outcome,
            metadata: {
              ...outcome.metadata,
              settlement_confirmation: 'get_payment_details',
            },
          },
        );
        return {
          ...result,
          paid: finalized.paid,
          actionRequired: finalized.actionRequired,
          failed: finalized.failed,
        };
      } catch (error) {
        this.logger.warn(
          `Unable to reconcile uncertain renewal payment=${prepared.paymentId} providerPayment=${prepared.gatewayPaymentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return result;
      }
    }
    const reserved = await this.reserveRenewalCharge(
      prepared.paymentId,
      prepared.idempotencyKey,
    );
    if (!reserved) {
      return result;
    }

    result.charged = true;
    try {
      const response = await this.myFatoorahClient.createPaymentV3(
        config.apiBaseUrl,
        config.apiToken,
        {
          PaymentMethod: 'CARD',
          Order: {
            Amount: prepared.amount,
            Currency: prepared.currency,
          },
          SourceOfFund: {
            Token: prepared.paymentToken.token_or_ref,
          },
          PaymentExpiry: prepared.paymentExpiry,
          MetaData: {
            payment_id: prepared.paymentId,
            invoice_id: invoiceId,
            tenant_id: prepared.tenantId,
            amount: prepared.amount,
            currency: prepared.currency,
          },
        },
        { idempotencyKey: prepared.idempotencyKey },
      );
      const outcome = await this.confirmRenewalChargeOutcome(
        response,
        config.apiBaseUrl,
        config.apiToken,
      );
      const finalized = await this.finalizeRenewalChargeOutcome(
        prepared.paymentId,
        outcome,
      );
      if (finalized.actionRequired || finalized.failed) {
        await this.notifyRecoveryIssueSafely(prepared.paymentId);
      }
      return {
        ...result,
        paid: finalized.paid,
        actionRequired: finalized.actionRequired,
        failed: finalized.failed,
      };
    } catch (error) {
      const finalized = await this.finalizeRenewalChargeOutcome(
        prepared.paymentId,
        {
          status: 'requires_action',
          message: `MyFatoorah renewal charge outcome unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
          gatewayPaymentId: null,
          gatewayInvoiceId: null,
          gatewayTransactionId: null,
          paymentUrl: null,
          metadata: {
            gateway_outcome: 'unknown',
            gateway_error:
              error instanceof Error ? error.message : String(error),
          },
        },
      );
      if (finalized.actionRequired || finalized.failed) {
        await this.notifyRecoveryIssueSafely(prepared.paymentId);
      }
      return {
        ...result,
        paid: finalized.paid,
        actionRequired: finalized.actionRequired,
        failed: finalized.failed,
      };
    }
  }

  private prepareRenewalChargeAttemptIfDue(
    subscriptionId: number,
  ): Promise<PreparedRenewalCharge | null> {
    return this.dataSource.transaction(async (manager) => {
      const subscriptionRepository = manager.getRepository(Subscription);
      const invoiceRepository = manager.getRepository(Invoice);
      const paymentRepository = manager.getRepository(Payment);
      const paymentTokenRepository = manager.getRepository(PaymentToken);
      const subscription = await subscriptionRepository
        .createQueryBuilder('subscription')
        .setLock('pessimistic_write', undefined, ['subscription'])
        .innerJoinAndSelect('subscription.store', 'store')
        .innerJoinAndSelect('subscription.plan', 'plan')
        .where('subscription.id = :subscriptionId', { subscriptionId })
        .andWhere('store.deleted_at IS NULL')
        .getOne();

      if (!subscription || !this.isRenewalDue(subscription, new Date())) {
        return null;
      }

      const periodStart = subscription.current_period_end;
      if (
        !(periodStart instanceof Date) ||
        !Number.isFinite(periodStart.getTime())
      ) {
        return null;
      }
      const billingCycle = subscription.billing_cycle;
      if (billingCycle !== 'monthly' && billingCycle !== 'annual') {
        return this.markRenewalInvalidBillingConfiguration(
          manager,
          paymentRepository,
          subscriptionRepository,
          subscription,
          `Unsupported billing cycle: ${String(billingCycle)}`,
          {
            failure_source: 'invalid_billing_cycle',
            billing_cycle: subscription.billing_cycle,
          },
        );
      }
      const periodEnd = addBillingCycle(periodStart, billingCycle);
      const renewalAmount = this.computeRenewalAmount(
        subscription.plan,
        billingCycle,
      );
      if (!renewalAmount.valid) {
        return this.markRenewalInvalidBillingConfiguration(
          manager,
          paymentRepository,
          subscriptionRepository,
          subscription,
          renewalAmount.failureReason,
          {
            failure_source: 'invalid_renewal_amount',
            billing_cycle: billingCycle,
            raw_amount: renewalAmount.rawAmount,
          },
        );
      }
      const amount = renewalAmount.amount;
      if (amount === 0) {
        return this.markZeroAmountRenewalPaid(
          invoiceRepository,
          paymentRepository,
          subscriptionRepository,
          subscription,
          billingCycle,
          periodStart,
          periodEnd,
        );
      }

      const paymentToken = await this.resolveDefaultRenewalPaymentToken(
        paymentTokenRepository,
        subscription,
      );
      const invoice = await this.findOrCreateRenewalInvoice(
        invoiceRepository,
        subscription,
        paymentToken,
        amount,
        billingCycle,
        periodStart,
        periodEnd,
      );
      if (!this.isValidRenewalInvoiceForSubscription(invoice, subscription)) {
        const voided = await voidMalformedPendingRenewalInvoice(
          invoiceRepository,
          invoice,
          subscription.id,
        );
        this.logger.warn(
          `${voided ? 'Voided' : 'Skipped'} malformed renewal invoice=${invoice.id} for subscription=${subscription.id}; manual intervention required`,
        );
        return null;
      }
      const existingOpenPayment = await paymentRepository.findOne({
        where: {
          invoice_id: invoice.id,
          status: In(['pending', 'requires_action']),
        },
        order: { id: 'DESC' },
      });
      if (existingOpenPayment) {
        if (existingOpenPayment.attempt_source !== 'automatic_renewal') {
          return null;
        }
        if (existingOpenPayment.status === 'requires_action') {
          return null;
        }
        if (this.hasGatewayChargeStarted(existingOpenPayment)) {
          if (!this.isStaleChargeReservation(existingOpenPayment)) {
            return null;
          }
          if (
            this.isUncertainChargeAttempt(existingOpenPayment) &&
            !this.providerPaymentId(existingOpenPayment)
          ) {
            return null;
          }
          const reservedPaymentToken = existingOpenPayment.payment_token_id
            ? await paymentTokenRepository.findOne({
                where: { id: existingOpenPayment.payment_token_id },
              })
            : null;
          if (!reservedPaymentToken?.token_or_ref) {
            return null;
          }
          return this.toPreparedRenewalCharge(
            existingOpenPayment,
            invoice,
            subscription,
            reservedPaymentToken,
            false,
          );
        }
        if (!paymentToken) {
          return this.markRenewalNoDefaultCard(
            paymentRepository,
            invoiceRepository,
            subscriptionRepository,
            existingOpenPayment,
            invoice,
            subscription,
            billingCycle,
            periodStart,
            periodEnd,
            amount,
          );
        }
        if (existingOpenPayment.payment_token_id === paymentToken.id) {
          return this.toPreparedRenewalCharge(
            existingOpenPayment,
            invoice,
            subscription,
            paymentToken,
            false,
          );
        }

        existingOpenPayment.status = 'failed';
        existingOpenPayment.failure_reason =
          'Superseded by a new automatic renewal attempt using the current default card';
        existingOpenPayment.metadata = {
          ...this.asRecord(existingOpenPayment.metadata),
          superseded_at: new Date().toISOString(),
          superseded_reason: 'default_card_changed_before_charge',
          superseded_by_source: 'automatic_renewal',
        };
        await paymentRepository.save(existingOpenPayment);
      }

      if (!paymentToken) {
        return this.markRenewalNoDefaultCard(
          paymentRepository,
          invoiceRepository,
          subscriptionRepository,
          null,
          invoice,
          subscription,
          billingCycle,
          periodStart,
          periodEnd,
          amount,
        );
      }

      invoice.payment_token_id = paymentToken.id;
      invoice.payment_method_snapshot =
        this.buildPaymentMethodSnapshot(paymentToken);
      await invoiceRepository.save(invoice);

      const payment = await paymentRepository.save(
        paymentRepository.create({
          invoice_id: invoice.id,
          user_id: subscription.store.user_id,
          store_id: subscription.store_id,
          amount,
          currency: invoice.currency,
          status: 'pending',
          attempt_source: 'automatic_renewal',
          payment_method: 'card',
          gateway: 'myfatoorah',
          payment_token_id: paymentToken.id,
          metadata: {
            purpose: 'renewal_subscription_payment',
            subscription_id: subscription.id,
            billing_cycle: billingCycle,
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            payment_token_id: paymentToken.id,
          },
        }),
      );

      return this.toPreparedRenewalCharge(
        payment,
        invoice,
        subscription,
        paymentToken,
        true,
      );
    });
  }

  private isCancellationDue(subscription: Subscription, now: Date): boolean {
    return (
      subscription.cancel_at_period_end &&
      subscription.current_period_end != null &&
      subscription.current_period_end.getTime() <= now.getTime() &&
      subscription.status !== 'cancelled' &&
      subscription.status !== 'expired'
    );
  }

  private isPendingPlanDue(subscription: Subscription, now: Date): boolean {
    return (
      subscription.pending_plan_id != null &&
      subscription.pending_plan != null &&
      subscription.current_period_end != null &&
      subscription.current_period_end.getTime() <= now.getTime() &&
      !subscription.cancel_at_period_end &&
      (subscription.status === 'active' || subscription.status === 'trialing')
    );
  }

  private isRenewalDue(subscription: Subscription, now: Date): boolean {
    if (
      subscription.cancel_at_period_end ||
      subscription.current_period_end == null ||
      subscription.current_period_end.getTime() > now.getTime()
    ) {
      return false;
    }

    if (subscription.status === 'active') {
      return true;
    }

    return (
      subscription.status === 'trialing' &&
      subscription.trial_ends_at != null &&
      subscription.trial_ends_at.getTime() <= now.getTime()
    );
  }

  private isValidRenewalInvoiceForSubscription(
    invoice: Invoice,
    subscription: Subscription,
    tenantId = subscription.store?.user_id,
  ): boolean {
    const periodStart = invoice.period_start;
    const periodEnd = invoice.period_end;
    return (
      Number.isSafeInteger(Number(invoice.subscription_id)) &&
      Number(invoice.subscription_id) === subscription.id &&
      invoice.store_id === subscription.store_id &&
      tenantId !== undefined &&
      invoice.user_id === tenantId &&
      periodStart instanceof Date &&
      Number.isFinite(periodStart.getTime()) &&
      periodEnd instanceof Date &&
      Number.isFinite(periodEnd.getTime()) &&
      periodStart < periodEnd
    );
  }

  private reserveRenewalCharge(
    paymentId: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      const payment = await paymentRepository
        .createQueryBuilder('payment')
        .setLock('pessimistic_write', undefined, ['payment'])
        .where('payment.id = :paymentId', { paymentId })
        .getOne();

      if (
        !payment ||
        payment.status !== 'pending' ||
        payment.attempt_source !== 'automatic_renewal' ||
        (this.hasGatewayChargeStarted(payment) &&
          !this.isStaleChargeReservation(payment))
      ) {
        return false;
      }

      const now = new Date().toISOString();
      const metadata = this.asRecord(payment.metadata);
      const chargeWasAlreadyReserved = this.hasGatewayChargeStarted(payment);
      const nowDate = new Date(now);
      if (
        chargeWasAlreadyReserved &&
        !isInsideMyFatoorahIdempotencyWindow(metadata, nowDate)
      ) {
        payment.failure_reason =
          'Automatic renewal charge outcome is uncertain; authoritative reconciliation or operator action is required';
        payment.metadata = {
          ...metadata,
          charge_state: 'uncertain',
          idempotency_window_expired_at: now,
          authoritative_reconciliation_required: true,
        };
        await paymentRepository.save(payment);
        return false;
      }
      const previousRecoveryCount = Number(metadata.charge_recovery_count);
      const firstRequestedAt =
        firstChargeRequestTimestamp(metadata) ?? nowDate.getTime();
      payment.metadata = {
        ...metadata,
        idempotency_key: idempotencyKey,
        charge_first_requested_at: new Date(firstRequestedAt).toISOString(),
        charge_started_at: now,
        charge_reservation_started_at: now,
        payment_attempted_at: now,
        ...(chargeWasAlreadyReserved
          ? {
              charge_reclaimed_at: now,
              charge_recovery_count:
                (Number.isFinite(previousRecoveryCount)
                  ? previousRecoveryCount
                  : 0) + 1,
            }
          : {}),
      };
      await paymentRepository.save(payment);
      return true;
    });
  }

  private finalizeRenewalChargeOutcome(
    paymentId: number,
    outcome: RenewalChargeOutcome,
  ): Promise<RenewalProcessResult> {
    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      const invoiceRepository = manager.getRepository(Invoice);
      const subscriptionRepository = manager.getRepository(Subscription);
      const paymentTokenRepository = manager.getRepository(PaymentToken);
      const payment = await paymentRepository
        .createQueryBuilder('payment')
        .setLock('pessimistic_write', undefined, ['payment'])
        .where('payment.id = :paymentId', { paymentId })
        .getOne();
      if (!payment?.invoice_id) {
        return this.emptyRenewalResult();
      }

      const invoice = await invoiceRepository
        .createQueryBuilder('invoice')
        .setLock('pessimistic_write', undefined, ['invoice'])
        .where('invoice.id = :invoiceId', { invoiceId: payment.invoice_id })
        .getOne();
      if (!invoice) {
        return this.emptyRenewalResult();
      }

      // Settlement success is terminal. A paid webhook can commit while the
      // worker is still waiting on (or timing out from) the original gateway
      // request, so never let that later non-paid result regress either row or
      // the subscription lifecycle.
      if (payment.status === 'paid' || invoice.status === 'paid') {
        return {
          ...this.emptyRenewalResult(),
          paid: true,
        };
      }

      const subscription = invoice.subscription_id
        ? await subscriptionRepository
            .createQueryBuilder('subscription')
            .setLock('pessimistic_write', undefined, ['subscription'])
            .where('subscription.id = :subscriptionId', {
              subscriptionId: invoice.subscription_id,
            })
            .getOne()
        : null;
      const validRenewalBinding = Boolean(
        subscription &&
        subscription.status !== 'cancelled' &&
        this.isValidRenewalInvoiceForSubscription(
          invoice,
          subscription,
          payment.user_id,
        ) &&
        payment.store_id === invoice.store_id &&
        Math.abs(Number(payment.amount) - Number(invoice.amount)) < 0.000001 &&
        payment.currency.trim().toUpperCase() ===
          invoice.currency.trim().toUpperCase(),
      );

      const paymentToken = payment.payment_token_id
        ? await paymentTokenRepository.findOne({
            where: { id: payment.payment_token_id },
          })
        : null;
      const metadata: Record<string, unknown> = {
        ...this.asRecord(payment.metadata),
        ...outcome.metadata,
        renewal_finalized_at: new Date().toISOString(),
      };
      if (outcome.paymentUrl) {
        metadata.payment_url = outcome.paymentUrl;
      }
      payment.metadata = metadata;
      payment.gateway_payment_id =
        outcome.gatewayPaymentId ?? payment.gateway_payment_id;
      payment.gateway_transaction_id =
        outcome.gatewayTransactionId ?? payment.gateway_transaction_id;

      if (outcome.status === 'paid') {
        const paidAt = new Date();
        payment.status = 'paid';
        payment.failure_reason = null;

        invoice.status = 'paid';
        invoice.paid_at = invoice.paid_at ?? paidAt;
        invoice.gateway_invoice_id =
          outcome.gatewayInvoiceId ?? invoice.gateway_invoice_id;
        if (payment.payment_token_id) {
          invoice.payment_token_id = payment.payment_token_id;
          if (paymentToken) {
            invoice.payment_method_snapshot =
              this.buildPaymentMethodSnapshot(paymentToken);
          }
        }

        if (!validRenewalBinding) {
          payment.metadata = {
            ...this.asRecord(payment.metadata),
            activation_state: 'blocked_invalid_renewal_binding',
            activation_blocked_at: new Date().toISOString(),
          };
        }

        if (validRenewalBinding && subscription) {
          subscription.status = 'active';
          subscription.cancel_at_period_end = false;
          if (
            invoice.period_start &&
            invoice.period_end &&
            this.shouldApplyRenewalPeriod(subscription, invoice)
          ) {
            subscription.current_period_start = invoice.period_start;
            subscription.current_period_end = invoice.period_end;
          }
          await subscriptionRepository.save(subscription);
        }

        await invoiceRepository.save(invoice);
        await paymentRepository.save(payment);
        return {
          ...this.emptyRenewalResult(),
          paid: true,
        };
      }

      if (outcome.status === 'failed') {
        payment.status = 'failed';
        payment.failure_reason = outcome.message;
      } else {
        payment.status = 'requires_action';
        payment.failure_reason = outcome.message;
      }

      if (invoice.status !== 'paid') {
        invoice.status = 'pending';
      }
      invoice.gateway_invoice_id =
        outcome.gatewayInvoiceId ?? invoice.gateway_invoice_id;
      if (
        validRenewalBinding &&
        subscription &&
        subscription.status !== 'cancelled'
      ) {
        subscription.status = 'past_due';
        await subscriptionRepository.save(subscription);
      }

      this.enqueueRecoveryIssue(payment);
      await invoiceRepository.save(invoice);
      await paymentRepository.save(payment);
      return {
        ...this.emptyRenewalResult(),
        actionRequired: outcome.status === 'requires_action',
        failed: outcome.status === 'failed',
      };
    });
  }

  private resolveRenewalChargeOutcome(
    response: MyFatoorahEnvelope,
  ): RenewalChargeOutcome {
    const data = response.Data ?? {};
    const paymentCompleted = this.readBoolean(data, 'PaymentCompleted');
    const paymentUrl =
      this.readString(data, 'PaymentURL') ??
      this.readString(data, 'PaymentUrl') ??
      this.readString(data, 'paymentURL');
    const gatewayPaymentId =
      this.readString(data, 'PaymentId') ??
      this.readString(data, 'PaymentID') ??
      this.readString(data, 'Id') ??
      this.readNestedString(data, [
        'TransactionDetails',
        'Transaction',
        'PaymentId',
      ]);
    const gatewayInvoiceId =
      this.readString(data, 'InvoiceId') ??
      this.readString(data, 'InvoiceID') ??
      this.readNestedString(data, ['Invoice', 'Id']) ??
      this.readNestedString(data, ['TransactionDetails', 'Invoice', 'Id']);
    const gatewayTransactionId =
      this.readString(data, 'TransactionId') ??
      this.readString(data, 'TransactionID') ??
      this.readNestedString(data, ['Transaction', 'Id']) ??
      this.readNestedString(data, ['TransactionDetails', 'Transaction', 'Id']);
    const metadata = {
      gateway_outcome: response.IsSuccess ? 'success' : 'failed',
      gateway_message: response.Message ?? null,
      payment_completed: paymentCompleted,
      payment_url: paymentUrl,
      provider_payment_id: gatewayPaymentId,
      provider_invoice_id: gatewayInvoiceId,
      provider_transaction_id: gatewayTransactionId,
    };

    if (!response.IsSuccess) {
      return {
        status: 'failed',
        message: response.Message ?? 'MyFatoorah renewal charge failed',
        gatewayPaymentId,
        gatewayInvoiceId,
        gatewayTransactionId,
        paymentUrl,
        metadata,
      };
    }

    const normalized = resolveStructuredMyFatoorahPaymentStatus(data);
    if (normalized === 'paid') {
      return {
        status: 'paid',
        message: 'MyFatoorah completed the renewal payment',
        gatewayPaymentId,
        gatewayInvoiceId,
        gatewayTransactionId,
        paymentUrl,
        metadata,
      };
    }

    if (normalized === 'failed') {
      return {
        status: 'failed',
        message: response.Message ?? 'MyFatoorah renewal charge was declined',
        gatewayPaymentId,
        gatewayInvoiceId,
        gatewayTransactionId,
        paymentUrl,
        metadata,
      };
    }

    if (paymentUrl) {
      return {
        status: 'requires_action',
        message: 'MyFatoorah requires customer action to complete renewal',
        gatewayPaymentId,
        gatewayInvoiceId,
        gatewayTransactionId,
        paymentUrl,
        metadata,
      };
    }

    return {
      status: 'requires_action',
      message:
        response.Message ??
        'MyFatoorah did not confirm renewal payment completion',
      gatewayPaymentId,
      gatewayInvoiceId,
      gatewayTransactionId,
      paymentUrl,
      metadata: {
        ...metadata,
        gateway_outcome: 'unknown',
      },
    };
  }

  private async confirmRenewalChargeOutcome(
    response: MyFatoorahEnvelope,
    baseUrl: string,
    apiToken: string,
  ): Promise<RenewalChargeOutcome> {
    const initial = this.resolveRenewalChargeOutcome(response);
    if (initial.status !== 'paid') {
      return initial;
    }
    if (!initial.gatewayPaymentId) {
      return {
        ...initial,
        status: 'requires_action',
        message: 'MyFatoorah did not return a payment id for verification',
        metadata: {
          ...initial.metadata,
          settlement_confirmation: 'missing_payment_id',
        },
      };
    }

    try {
      const confirmation = await this.myFatoorahClient.getPaymentV3(
        baseUrl,
        apiToken,
        initial.gatewayPaymentId,
      );
      const confirmed = this.resolveRenewalChargeOutcome(confirmation);
      return {
        ...confirmed,
        paymentUrl: confirmed.paymentUrl ?? initial.paymentUrl,
        gatewayPaymentId:
          confirmed.gatewayPaymentId ?? initial.gatewayPaymentId,
        gatewayInvoiceId:
          confirmed.gatewayInvoiceId ?? initial.gatewayInvoiceId,
        gatewayTransactionId:
          confirmed.gatewayTransactionId ?? initial.gatewayTransactionId,
        metadata: {
          ...initial.metadata,
          ...confirmed.metadata,
          settlement_confirmation: 'get_payment_details',
        },
      };
    } catch (error) {
      return {
        ...initial,
        status: 'requires_action',
        message: `Unable to verify MyFatoorah settlement: ${
          error instanceof Error ? error.message : String(error)
        }`,
        metadata: {
          ...initial.metadata,
          settlement_confirmation: 'unavailable',
          settlement_confirmation_error:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private toPreparedRenewalCharge(
    payment: Payment,
    invoice: Invoice,
    subscription: Subscription,
    paymentToken: PaymentToken,
    prepared: boolean,
  ): PreparedRenewalCharge {
    return {
      paymentId: payment.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      tenantId: subscription.store.user_id,
      storeId: subscription.store_id,
      amount: Number(payment.amount),
      currency: payment.currency,
      paymentToken,
      idempotencyKey:
        this.readString(this.asRecord(payment.metadata), 'idempotency_key') ??
        `renewal-payment-${payment.id}`,
      paymentExpiry: this.paymentExpiryForInvoice(invoice),
      prepared,
      gatewayPaymentId: this.providerPaymentId(payment) ?? undefined,
    };
  }

  private paymentExpiryForInvoice(invoice: Invoice): string {
    const periodStart = invoice.period_start;
    if (
      !(periodStart instanceof Date) ||
      !Number.isFinite(periodStart.getTime())
    ) {
      throw new Error(
        `Renewal invoice ${invoice.id} has no valid grace deadline`,
      );
    }
    return billingGraceEndsAt(periodStart).toISOString();
  }

  private emptyRenewalResult(): RenewalProcessResult {
    return {
      prepared: false,
      charged: false,
      paid: false,
      actionRequired: false,
      failed: false,
    };
  }

  private async notifyRecoveryIssueSafely(paymentId: number): Promise<void> {
    if (!this.billingRecoveryService) {
      return;
    }
    try {
      await this.billingRecoveryService.notifyPaymentRecoveryIssue(paymentId);
    } catch (error) {
      this.logger.warn(
        `Failed to send billing recovery notification for payment=${paymentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private enqueueRecoveryIssue(payment: Payment): void {
    this.billingRecoveryService?.enqueuePaymentRecoveryIssue(payment);
  }

  private hasGatewayChargeStarted(payment: Payment): boolean {
    const metadata = this.asRecord(payment.metadata);
    return Boolean(
      payment.gateway_payment_id ||
      payment.gateway_transaction_id ||
      metadata.charge_started_at ||
      metadata.idempotency_key ||
      metadata.payment_url ||
      metadata.provider_payment_id,
    );
  }

  private isStaleChargeReservation(payment: Payment): boolean {
    const metadata = this.asRecord(payment.metadata);
    const startedAt =
      this.readString(metadata, 'charge_reservation_started_at') ??
      this.readString(metadata, 'charge_started_at');
    if (!startedAt) {
      return false;
    }
    const timestamp = Date.parse(startedAt);
    return (
      Number.isFinite(timestamp) &&
      Date.now() - timestamp >= CHARGE_RESERVATION_TIMEOUT_MS
    );
  }

  private providerPaymentId(payment: Payment): string | null {
    return (
      payment.gateway_payment_id ??
      this.readString(this.asRecord(payment.metadata), 'provider_payment_id') ??
      null
    );
  }

  private isUncertainChargeAttempt(payment: Payment): boolean {
    return (
      this.readString(this.asRecord(payment.metadata), 'charge_state') ===
      'uncertain'
    );
  }

  private shouldApplyRenewalPeriod(
    subscription: Subscription,
    invoice: Invoice,
  ): boolean {
    if (!invoice.period_start || !invoice.period_end) {
      return false;
    }
    if (!subscription.current_period_end) {
      return true;
    }
    if (
      subscription.current_period_start?.getTime() ===
      invoice.period_start.getTime()
    ) {
      return true;
    }
    return (
      subscription.current_period_end.getTime() <=
      invoice.period_start.getTime()
    );
  }

  private async markRenewalNoDefaultCard(
    paymentRepository: Repository<Payment>,
    invoiceRepository: Repository<Invoice>,
    subscriptionRepository: Repository<Subscription>,
    existingOpenPayment: Payment | null,
    invoice: Invoice,
    subscription: Subscription,
    billingCycle: BillingCycle,
    periodStart: Date,
    periodEnd: Date,
    amount: number,
  ): Promise<PreparedRenewalCharge> {
    const now = new Date().toISOString();
    const failureReason =
      'No default MyFatoorah payment card configured for automatic renewal';
    const metadata = {
      purpose: 'renewal_subscription_payment',
      subscription_id: subscription.id,
      billing_cycle: billingCycle,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      payment_token_id: null,
      failure_source: 'no_default_payment_card',
      failed_at: now,
    };

    invoice.status = invoice.status === 'paid' ? invoice.status : 'pending';
    invoice.payment_token_id = null;
    invoice.payment_method_snapshot = null;
    await invoiceRepository.save(invoice);

    subscription.status = 'past_due';
    await subscriptionRepository.save(subscription);

    const payment = existingOpenPayment
      ? existingOpenPayment
      : paymentRepository.create({
          invoice_id: invoice.id,
          user_id: subscription.store.user_id,
          store_id: subscription.store_id,
          amount,
          currency: invoice.currency,
          attempt_source: 'automatic_renewal',
          payment_method: 'card',
          gateway: 'myfatoorah',
        });

    payment.status = 'failed';
    payment.failure_reason = failureReason;
    payment.payment_token_id = null;
    payment.metadata = {
      ...this.asRecord(payment.metadata),
      ...metadata,
    };
    this.enqueueRecoveryIssue(payment);

    const savedPayment = await paymentRepository.save(payment);

    return {
      paymentId: savedPayment.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      tenantId: subscription.store.user_id,
      storeId: subscription.store_id,
      amount: Number(savedPayment.amount),
      currency: savedPayment.currency,
      paymentToken: null,
      idempotencyKey: `renewal-payment-${savedPayment.id}`,
      prepared: true,
      failedWithoutCharge: true,
    };
  }

  private async markRenewalInvalidBillingConfiguration(
    manager: EntityManager,
    paymentRepository: Repository<Payment>,
    subscriptionRepository: Repository<Subscription>,
    subscription: Subscription,
    failureReason: string,
    metadata: Record<string, unknown>,
  ): Promise<PreparedRenewalCharge> {
    this.logger.warn(
      `Subscription renewal skipped because billing configuration is invalid subscription=${subscription.id}: ${failureReason}`,
    );

    // The paid period has ended and this configuration cannot produce a
    // recoverable invoice. Expire entitlement immediately so a missing
    // renewal price cannot strand the store in an indefinitely-accessible
    // past_due state.
    subscription.status = 'expired';
    await subscriptionRepository.save(subscription);
    const suspendedStoreId =
      await this.billingRecoveryService?.suspendStoreForInvalidBillingConfiguration(
        manager,
        subscription,
        failureReason,
      );

    const payment = paymentRepository.create({
      invoice_id: null,
      user_id: subscription.store.user_id,
      store_id: subscription.store_id,
      amount: 0,
      currency: subscription.plan.currency ?? 'KWD',
      status: 'failed',
      attempt_source: 'automatic_renewal',
      payment_method: 'card',
      gateway: 'myfatoorah',
      payment_token_id: null,
      failure_reason: failureReason,
      metadata: {
        purpose: 'renewal_subscription_payment',
        subscription_id: subscription.id,
        plan_id: subscription.plan_id,
        failed_at: new Date().toISOString(),
        access_expired: true,
        ...metadata,
      },
    });
    const savedPayment = await paymentRepository.save(payment);

    return {
      paymentId: savedPayment.id,
      invoiceId: null,
      subscriptionId: subscription.id,
      tenantId: subscription.store.user_id,
      storeId: subscription.store_id,
      amount: 0,
      currency: savedPayment.currency,
      paymentToken: null,
      idempotencyKey: `renewal-payment-${payment.id}`,
      prepared: true,
      failedWithoutCharge: true,
      suspendedStoreId: suspendedStoreId ?? undefined,
    };
  }

  private async markZeroAmountRenewalPaid(
    invoiceRepository: Repository<Invoice>,
    paymentRepository: Repository<Payment>,
    subscriptionRepository: Repository<Subscription>,
    subscription: Subscription,
    billingCycle: BillingCycle,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PreparedRenewalCharge> {
    const amount = 0;
    const invoice = await this.findOrCreateRenewalInvoice(
      invoiceRepository,
      subscription,
      null,
      amount,
      billingCycle,
      periodStart,
      periodEnd,
    );
    const paidAt = new Date();
    invoice.status = 'paid';
    invoice.paid_at = invoice.paid_at ?? paidAt;
    invoice.payment_token_id = null;
    invoice.payment_method_snapshot = null;
    await invoiceRepository.save(invoice);

    const payment = await paymentRepository.save(
      paymentRepository.create({
        invoice_id: invoice.id,
        user_id: subscription.store.user_id,
        store_id: subscription.store_id,
        amount,
        currency: invoice.currency,
        status: 'paid',
        attempt_source: 'automatic_renewal',
        payment_method: 'free',
        gateway: null,
        payment_token_id: null,
        failure_reason: null,
        metadata: {
          purpose: 'renewal_subscription_payment',
          subscription_id: subscription.id,
          billing_cycle: billingCycle,
          period_start: periodStart.toISOString(),
          period_end: periodEnd.toISOString(),
          payment_completed_without_charge: true,
          paid_at: paidAt.toISOString(),
        },
      }),
    );

    subscription.status = 'active';
    subscription.cancel_at_period_end = false;
    subscription.current_period_start = periodStart;
    subscription.current_period_end = periodEnd;
    await subscriptionRepository.save(subscription);

    return {
      paymentId: payment.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      tenantId: subscription.store.user_id,
      storeId: subscription.store_id,
      amount,
      currency: invoice.currency,
      paymentToken: null,
      idempotencyKey: `renewal-payment-${payment.id}`,
      prepared: true,
      paidWithoutCharge: true,
    };
  }

  private async findOrCreateRenewalInvoice(
    invoiceRepository: Repository<Invoice>,
    subscription: Subscription,
    paymentToken: PaymentToken | null,
    amount: number,
    billingCycle: BillingCycle,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Invoice> {
    const existing = await invoiceRepository.findOne({
      where: {
        subscription_id: subscription.id,
        invoice_type: 'renewal',
        period_start: periodStart,
      },
      order: { id: 'DESC' },
    });
    if (existing) {
      return existing;
    }

    const currency = subscription.plan.currency ?? 'KWD';
    return invoiceRepository.save(
      invoiceRepository.create({
        user_id: subscription.store.user_id,
        store_id: subscription.store_id,
        subscription_id: subscription.id,
        invoice_number: this.generateInvoiceNumber(subscription.store.user_id),
        amount,
        currency,
        status: 'pending',
        invoice_type: 'renewal',
        period_start: periodStart,
        period_end: periodEnd,
        due_date: periodEnd,
        gateway: 'myfatoorah',
        payment_token_id: paymentToken?.id ?? null,
        payment_method_snapshot: paymentToken
          ? this.buildPaymentMethodSnapshot(paymentToken)
          : null,
        line_items: [
          {
            plan_id: subscription.plan.id,
            plan_slug: subscription.plan.slug,
            plan_name: subscription.plan.name_en,
            billing_cycle: billingCycle,
            price_monthly: Number(subscription.plan.price_monthly),
            price_yearly:
              subscription.plan.price_yearly == null
                ? null
                : Number(subscription.plan.price_yearly),
            amount,
            currency,
            service_period_start: periodStart.toISOString(),
            service_period_end: periodEnd.toISOString(),
            features_en: subscription.plan.features_en,
            features_ar: subscription.plan.features_ar,
            limits: subscription.plan.limits,
            description: `Renewal - ${subscription.plan.name_en} (${billingCycle})`,
          },
        ],
        notes: `Auto-prepared renewal for subscription ${subscription.id}`,
      }),
    );
  }

  private computeRenewalAmount(
    plan: Subscription['plan'],
    billingCycle: BillingCycle,
  ): RenewalAmountResult {
    const raw =
      billingCycle === 'annual' ? plan.price_yearly : plan.price_monthly;
    if (raw == null) {
      return {
        valid: false,
        amount: 0,
        failureReason: `Missing ${billingCycle} renewal price for plan ${plan.id}`,
        rawAmount: raw,
      };
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount)) {
      return {
        valid: false,
        amount: 0,
        failureReason: `Invalid ${billingCycle} renewal price for plan ${plan.id}`,
        rawAmount: raw,
      };
    }
    if (amount < 0) {
      return {
        valid: false,
        amount: 0,
        failureReason: `Negative ${billingCycle} renewal price for plan ${plan.id}`,
        rawAmount: raw,
      };
    }
    return { valid: true, amount };
  }

  private generateInvoiceNumber(tenantId: number): string {
    return `INV-${tenantId}-${Date.now()}-${randomBytes(8).toString('hex')}`;
  }

  private async resolveDefaultRenewalPaymentToken(
    paymentTokenRepository: Repository<PaymentToken>,
    subscription: Subscription,
  ): Promise<PaymentToken | null> {
    return paymentTokenRepository.findOne({
      where: {
        user_id: subscription.store.user_id,
        provider: 'myfatoorah',
        is_default: true,
        method_type: 'card_token',
      },
      order: { id: 'DESC' },
    });
  }

  private buildPaymentMethodSnapshot(paymentToken: PaymentToken) {
    const metadata = paymentToken.metadata as Record<string, unknown>;
    return {
      brand: (metadata.brand as string | null | undefined) ?? null,
      last4: (metadata.last4 as string | null | undefined) ?? null,
      maskedNumber:
        (metadata.maskedNumber as string | null | undefined) ?? null,
      tokenType: (metadata.tokenType as string | null | undefined) ?? null,
      is3DSVerified:
        (metadata.is3DSVerified as boolean | null | undefined) ?? null,
      captured_at: new Date().toISOString(),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private readBoolean(
    data: Record<string, unknown> | undefined,
    key: string,
  ): boolean | null {
    const value = data?.[key];
    return typeof value === 'boolean' ? value : null;
  }

  private readString(
    data: Record<string, unknown> | undefined,
    key: string,
  ): string | null {
    return data ? this.readScalarString(data[key]) : null;
  }

  private readNestedString(
    data: Record<string, unknown>,
    path: string[],
  ): string | null {
    let current: unknown = data;
    for (const segment of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return this.readScalarString(current);
  }

  private readScalarString(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return null;
  }

  private logTransitionFailure(
    transition: 'cancellation' | 'pending-plan' | 'renewal',
    subscriptionId: number,
    error: unknown,
  ) {
    this.logger.error(
      `Subscription lifecycle ${transition} transition failed subscription=${subscriptionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
