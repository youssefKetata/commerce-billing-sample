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
import { Invoice } from "./invoice.entity";
import { User } from "./user.entity";
import { Store } from "./store.entity";
import { PaymentToken } from "./payment-token.entity";
import {
  billingDecimalTransformer,
  MAX_BILLING_AMOUNT,
} from "../utils/currency";

export const PAYMENT_ATTEMPT_SOURCES = [
  "customer_checkout",
  "admin_checkout",
  "automatic_renewal",
] as const;
export type PaymentAttemptSource = (typeof PAYMENT_ATTEMPT_SOURCES)[number];

@Index("idx_payments_user", ["user_id"])
@Index("idx_payments_store", ["store_id"])
@Index("idx_payments_invoice", ["invoice_id"])
@Index("idx_payments_payment_token", ["payment_token_id"])
@Index("idx_payments_attempt_source", ["attempt_source"])
@Index("uq_payments_gateway_payment", ["gateway", "gateway_payment_id"], {
  unique: true,
  where: `"gateway" IS NOT NULL AND "gateway_payment_id" IS NOT NULL AND BTRIM("gateway_payment_id") <> ''`,
})
@Index(
  "uq_payments_gateway_transaction",
  ["gateway", "gateway_transaction_id"],
  {
    unique: true,
    where: `"gateway" IS NOT NULL AND "gateway_transaction_id" IS NOT NULL AND BTRIM("gateway_transaction_id") <> ''`,
  },
)
@Index("uq_payments_open_invoice_attempt", ["invoice_id"], {
  unique: true,
  where: `"invoice_id" IS NOT NULL AND "status" IN ('pending', 'requires_action')`,
})
@Check(
  "chk_payments_attempt_source",
  `"attempt_source" IN ('customer_checkout', 'admin_checkout', 'automatic_renewal')`,
)
@Check(
  "chk_payments_amounts",
  `"amount" >= 0 AND "amount" <= ${MAX_BILLING_AMOUNT} AND "refunded_amount" >= 0 AND "refunded_amount" <= "amount"`,
)
@Check("chk_payments_currency", `"currency" = 'KWD'`)
@Entity({ name: "payments" })
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int", nullable: true })
  invoice_id: number | null;

  @ManyToOne(() => Invoice, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({
    name: "invoice_id",
    foreignKeyConstraintName: "FK_payments_invoice",
  })
  invoice: Invoice | null;

  @Column({ type: "int" })
  user_id: number;

  @ManyToOne(() => User)
  @JoinColumn({
    name: "user_id",
    foreignKeyConstraintName: "FK_payments_user",
  })
  user: User;

  @Column({ type: "int" })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: "CASCADE" })
  @JoinColumn({
    name: "store_id",
    foreignKeyConstraintName: "FK_payments_store",
  })
  store: Store;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 3,
    transformer: billingDecimalTransformer,
  })
  amount: number;

  @Column({ length: 3, default: "KWD" })
  currency: string;

  @Column({ length: 50, default: "pending" })
  status: string;

  @Column({ length: 50, default: "customer_checkout" })
  attempt_source: PaymentAttemptSource;

  @Column({ length: 50, nullable: true })
  payment_method: string | null;

  @Column({ length: 50, nullable: true })
  gateway: string | null;

  @Column({ length: 255, nullable: true })
  gateway_payment_id: string | null;

  @Column({ length: 255, nullable: true })
  gateway_transaction_id: string | null;

  @Column({ type: "text", nullable: true })
  failure_reason: string | null;

  @Column({ type: "text", nullable: true })
  receipt_url: string | null;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 3,
    default: 0,
    transformer: billingDecimalTransformer,
  })
  refunded_amount: number;

  @Column({ type: "timestamptz", nullable: true })
  refunded_at: Date | null;

  @Column({ type: "int", nullable: true })
  payment_token_id: number | null;

  @ManyToOne(() => PaymentToken, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({
    name: "payment_token_id",
    foreignKeyConstraintName: "FK_payments_payment_token",
  })
  payment_token: PaymentToken | null;

  @Column({ type: "jsonb", default: {} })
  metadata: object;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
