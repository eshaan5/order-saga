/**
 * Shapes returned by the coordinator API.
 *
 * Hand-written rather than imported from @saga/shared: the frontend is outside
 * the npm workspace on purpose, and a UI that depends on backend internals is
 * a coupling you pay for later. These mirror only the JSON contract.
 */

export type OrderStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PLACED'
  | 'COMPENSATING'
  | 'CANCELLED'
  | 'NEEDS_ATTENTION'
  | 'SHIPPED';

export const ALL_STATUSES: OrderStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'PLACED',
  'COMPENSATING',
  'CANCELLED',
  'NEEDS_ATTENTION',
  'SHIPPED',
];

/** Human labels — the UI shows "Needs attention", the API says NEEDS_ATTENTION. */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  PLACED: 'Placed',
  COMPENSATING: 'Compensating',
  CANCELLED: 'Cancelled',
  NEEDS_ATTENTION: 'Needs attention',
  SHIPPED: 'Shipped',
};

export interface OrderListItem {
  orderId: string;
  sku: string;
  qty: number;
  amount: string;
  status: OrderStatus;
  stepsDone: number;
  stepsTotal: number;
  updatedAt: string;
}

export interface OrderListPage {
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type StepKind = 'FORWARD' | 'COMPENSATION';
export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface StepRow {
  step: string;
  kind: StepKind;
  status: StepStatus;
  attempts: number;
  idempotency_key: string;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AttemptRow {
  step: string;
  attempt_no: number;
  outcome: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
  error_message: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string;
}

export interface OrderDetail {
  order: {
    order_id: string;
    sku: string;
    qty: number;
    amount: string;
    status: OrderStatus;
    fail_at: string | null;
    comp_fail_at: string | null;
    attempt_count: number;
    lease_owner: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  };
  steps: StepRow[];
  attempts: AttemptRow[];
}

export type Stats = Partial<Record<OrderStatus, number>>;
