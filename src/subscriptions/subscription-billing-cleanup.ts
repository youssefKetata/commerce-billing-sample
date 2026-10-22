import { Invoice, Payment } from '@commerce/database';
import { Repository } from 'typeorm';

const OPEN_INVOICE_STATUSES = ['pending', 'draft'];
const OPEN_PAYMENT_ATTEMPT_STATUSES = ['pending', 'requires_action'];

export async function voidMalformedPendingRenewalInvoice(
  invoiceRepository: Repository<Invoice>,
  invoice: Invoice,
  subscriptionId: number,
): Promise<boolean> {
  if (invoice.status !== 'pending' || invoice.invoice_type !== 'renewal') {
    return false;
  }

  const notes =
    `Manual intervention required: malformed renewal invoice binding ` +
    `(invoice=${invoice.id}, subscription=${subscriptionId})`;
  const result = await invoiceRepository.update(
    {
      id: invoice.id,
      status: 'pending',
      invoice_type: 'renewal',
    },
    {
      status: 'voided',
      notes,
    },
  );
  if (result.affected !== 1) {
    return false;
  }

  invoice.status = 'voided';
  invoice.notes = notes;
  return true;
}

export async function voidOpenBillingRecordsForSubscription(
  invoiceRepository: Repository<Invoice>,
  paymentRepository: Repository<Payment>,
  subscriptionId: number,
  reason: string,
): Promise<void> {
  await paymentRepository
    .createQueryBuilder()
    .update(Payment)
    .set({ status: 'failed', failure_reason: reason })
    .where(
      `invoice_id IN (
        SELECT id
        FROM invoices
        WHERE subscription_id = :subscriptionId
      )`,
      { subscriptionId },
    )
    .andWhere('status IN (:...openPaymentStatuses)', {
      openPaymentStatuses: OPEN_PAYMENT_ATTEMPT_STATUSES,
    })
    .execute();

  await invoiceRepository
    .createQueryBuilder()
    .update(Invoice)
    .set({ status: 'voided', notes: reason })
    .where('subscription_id = :subscriptionId', { subscriptionId })
    .andWhere('status IN (:...openStatuses)', {
      openStatuses: OPEN_INVOICE_STATUSES,
    })
    .execute();
}
