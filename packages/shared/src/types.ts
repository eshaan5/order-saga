/**
 * The vocabulary of the whole system. Every service and the coordinator agree
 * on these names, and they match the CSV's fail_at / comp_fail_at values and
 * the ENUMs in db/01-saga.sql exactly.
 */

// `as const` freezes these into literal types rather than widening to string[],
// which is what lets ForwardStep below be a union of the four exact strings.
export const FORWARD_STEPS = [
  'CREATE_ORDER',
  'RESERVE_INVENTORY',
  'CHARGE_PAYMENT',
  'CREATE_SHIPMENT',
] as const;

export const COMPENSATION_STEPS = [
  'CANCEL_ORDER',
  'RELEASE_INVENTORY',
  'REFUND_PAYMENT',
  'CANCEL_SHIPMENT',
] as const;

export type ForwardStep = (typeof FORWARD_STEPS)[number];
export type CompensationStep = (typeof COMPENSATION_STEPS)[number];
export type Step = ForwardStep | CompensationStep;

export type StepKind = 'FORWARD' | 'COMPENSATION';

/**
 * Which undo pairs with which do. The coordinator reads the forward steps that
 * SUCCEEDED and maps them through this to decide what to compensate.
 *
 * Typed as Record<ForwardStep, CompensationStep>, so if a step is ever added to
 * FORWARD_STEPS without a matching entry here, this fails to compile.
 */
export const COMPENSATION_OF: Record<ForwardStep, CompensationStep> = {
  CREATE_ORDER: 'CANCEL_ORDER',
  RESERVE_INVENTORY: 'RELEASE_INVENTORY',
  CHARGE_PAYMENT: 'REFUND_PAYMENT',
  CREATE_SHIPMENT: 'CANCEL_SHIPMENT',
};

export type ServiceName = 'order' | 'inventory' | 'payment' | 'shipping';

/** Which service owns each operation — tells the coordinator which URL to call. */
export const STEP_SERVICE: Record<Step, ServiceName> = {
  CREATE_ORDER: 'order',
  CANCEL_ORDER: 'order',
  RESERVE_INVENTORY: 'inventory',
  RELEASE_INVENTORY: 'inventory',
  CHARGE_PAYMENT: 'payment',
  REFUND_PAYMENT: 'payment',
  CREATE_SHIPMENT: 'shipping',
  CANCEL_SHIPMENT: 'shipping',
};

/** CREATE_ORDER -> "/create-order". Every service exposes its ops this way. */
export function stepPath(step: Step): string {
  return '/' + step.toLowerCase().replace(/_/g, '-');
}

export function isForwardStep(step: Step): step is ForwardStep {
  return (FORWARD_STEPS as readonly string[]).includes(step);
}

export function stepKind(step: Step): StepKind {
  return isForwardStep(step) ? 'FORWARD' : 'COMPENSATION';
}

/**
 * Deterministic idempotency key — derived from the order and step, NEVER
 * generated per attempt. This is the single most important line in the system:
 * because retry #2 sends the same key as retry #1, a service that already did
 * the work recognises it and replays the stored result instead of charging
 * the customer a second time.
 */
export function idempotencyKey(orderId: string, step: Step): string {
  return `${orderId}:${step}`;
}

// ---------------------------------------------------------------------------
// Order + step status vocabularies (mirror the MySQL ENUMs)
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PLACED'
  | 'COMPENSATING'
  | 'CANCELLED'
  | 'NEEDS_ATTENTION'
  | 'SHIPPED';

export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export type AttemptOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';

// ---------------------------------------------------------------------------
// Wire format between coordinator and services
// ---------------------------------------------------------------------------

export interface StepRequestBody {
  orderId: string;
  sku: string;
  qty: number;
  /**
   * String, not number. MySQL DECIMAL arrives from mysql2 as a string
   * specifically so JS floating point can't corrupt the cents, and we keep it
   * that way all the way across the wire.
   */
  amount: string;

  /** Fault injection, carried from the CSV. */
  failAt?: string | null;
  compFailAt?: string | null;

  /**
   * Set only by the manual "Retry" button in the UI. Tells the service to
   * ignore its injected compFailAt failure, so a NEEDS_ATTENTION order can
   * actually be cleared by a human. Without this the retry button would be a
   * dead end, since compFailAt otherwise fails every single time.
   */
  force?: boolean;
}

export interface StepResponseBody {
  ok: true;
  operation: Step;
  orderId: string;
  /** True when served from the idempotency record rather than re-executed. */
  replayed: boolean;
  data?: Record<string, unknown>;
}

export interface ErrorResponseBody {
  ok: false;
  error: string;
  code?: string;
}
