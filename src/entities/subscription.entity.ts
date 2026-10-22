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

import { SubscriptionPlan } from "./subscription-plan.entity";
import { Store } from "./store.entity";
import type { BillingCycle } from "../utils/billing-cycle";

// Subscription status types
export const SUBSCRIPTION_STATUSES = [
  "pending_payment",
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

@Index("UQ_subscriptions_store_id", ["store_id"], { unique: true })
@Index("idx_subscriptions_status", ["status"])
@Check(
  "chk_subscriptions_billing_cycle",
  `"billing_cycle" IS NULL OR "billing_cycle" IN ('monthly', 'annual')`,
)
@Check(
  "chk_subscriptions_period",
  `(("current_period_start" IS NULL AND "current_period_end" IS NULL) OR ("current_period_start" IS NOT NULL AND "current_period_end" IS NOT NULL AND "current_period_end" > "current_period_start"))`,
)
@Entity({ name: "subscriptions" })
export class Subscription {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  store_id: number;

  @ManyToOne(() => Store, { onDelete: "CASCADE" })
  @JoinColumn({
    name: "store_id",
    foreignKeyConstraintName: "FK_subscriptions_store",
  })
  store: Store;

  @Column({ type: "int" })
  plan_id: number;

  @ManyToOne(() => SubscriptionPlan)
  @JoinColumn({ name: "plan_id" })
  plan: SubscriptionPlan;

  @Column({ type: "int", nullable: true })
  pending_plan_id: number | null;

  @ManyToOne(() => SubscriptionPlan, { nullable: true })
  @JoinColumn({ name: "pending_plan_id" })
  pending_plan: SubscriptionPlan | null;

  @Column({ length: 50, default: "pending_payment" })
  status: SubscriptionStatus;

  @Column({ type: "timestamptz", nullable: true })
  trial_ends_at: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  current_period_start: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  current_period_end: Date | null;

  @Column({ default: false })
  cancel_at_period_end: boolean;

  @Column({ type: "timestamptz", nullable: true })
  cancelled_at: Date | null;

  @Column({ length: 20, nullable: true, default: "monthly" })
  billing_cycle: BillingCycle | null;

  @Column({ length: 50, nullable: true })
  gateway: string | null;

  // not used
  @Column({ length: 255, nullable: true })
  gateway_customer_id: string | null;

  // not used
  @Column({ length: 255, nullable: true })
  gateway_subscription_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
