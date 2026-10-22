import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Check,
} from "typeorm";
import { User } from "./user.entity";
import { Subscription } from "./subscription.entity";
import { PaymentToken } from "./payment-token.entity";
import { Store } from "./store.entity";
import {
  billingDecimalTransformer,
  MAX_BILLING_AMOUNT,
} from "../utils/currency";

export interface InvoicePaymentMethodSnapshot {
  brand?: string | null;
  last4?: string | null;
  maskedNumber?: string | null;
  tokenType?: string | null;
  is3DSVerified?: boolean | null;
  captured_at?: string | null;
}

@Index("idx_invoices_user", ["user_id"])
@Index("idx_invoices_store", ["store_id"])
@Index("idx_invoices_status", ["status"])
@Index("idx_invoices_payment_token", ["payment_token_id"])
@Index("idx_invoices_subscription_period", [
  "subscription_id",
  "invoice_type",
  "period_start",
  "period_end",
])
@Index(
  "uq_invoices_renewal_subscription_period",
  ["subscription_id", "period_start"],
  {
    unique: true,
    where: `"invoice_type" = 'renewal' AND "subscription_id" IS NOT NULL AND "period_start" IS NOT NULL`,
  },
)
@Index("uq_invoices_gateway_invoice", ["gateway", "gateway_invoice_id"], {
  unique: true,
  where: `"gateway" IS NOT NULL AND "gateway_invoice_id" IS NOT NULL AND BTRIM("gateway_invoice_id") <> ''`,
})
@Check(
  "chk_invoices_amount",
  `"amount" >= 0 AND "amount" <= ${MAX_BILLING_AMOUNT}`,
)
@Check("chk_invoices_currency", `"currency" = 'KWD'`)
@Check(
  "chk_invoices_period",
  `(("period_start" IS NULL AND "period_end" IS NULL) OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" > "period_start"))`,
)
@Entity({ name: "invoices" })
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  user_id: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ type: "int" })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: "CASCADE" })
  @JoinColumn({
    name: "store_id",
    foreignKeyConstraintName: "FK_invoices_store",
  })
  store: Store;

  @Column({ type: "int", nullable: true })
  subscription_id: number | null;

  @ManyToOne(() => Subscription, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "subscription_id" })
  subscription: Subscription | null;

  @Column({ length: 50, unique: true })
  invoice_number: string;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 3,
    transformer: billingDecimalTransformer,
  })
  amount: number;

  @Column({ length: 3, default: "KWD" })
  currency: string;

  @Column({ length: 50, default: "draft" })
  status: string;

  @Column({ length: 50, default: "standard" })
  invoice_type: string;

  @Column({ type: "timestamptz", nullable: true })
  period_start: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  period_end: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  due_date: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  paid_at: Date | null;

  @Column({ length: 50, nullable: true })
  gateway: string | null;

  @Column({ length: 255, nullable: true })
  gateway_invoice_id: string | null;

  @Column({ type: "text", nullable: true })
  pdf_url: string | null;

  @Column({ type: "text", nullable: true })
  notes: string | null;

  @Column({ type: "jsonb", default: [] })
  line_items: object;

  @Column({ type: "int", nullable: true })
  payment_token_id: number | null;

  @ManyToOne(() => PaymentToken, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({
    name: "payment_token_id",
    foreignKeyConstraintName: "FK_invoices_payment_token",
  })
  payment_token: PaymentToken | null;

  @Column({ type: "jsonb", nullable: true })
  payment_method_snapshot: InvoicePaymentMethodSnapshot | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
