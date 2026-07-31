import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { Api } from '../../core/api';
import { STATUS_LABEL, type OrderDetail as Detail, type OrderStatus } from '../../core/models';

@Component({
  selector: 'app-order-detail',
  imports: [RouterLink, DatePipe],
  templateUrl: './order-detail.html',
  styleUrl: './order-detail.css',
})
export class OrderDetail {
  private api = inject(Api);
  private route = inject(ActivatedRoute);

  readonly detail = signal<Detail | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  /**
   * The four do-steps and the four undo-steps, shown as separate tables.
   *
   * computed() derives from detail() and recomputes only when it changes —
   * no manual re-filtering, no $watch.
   */
  readonly forwardSteps = computed(
    () => this.detail()?.steps.filter((s) => s.kind === 'FORWARD') ?? [],
  );
  readonly compensationSteps = computed(
    () => this.detail()?.steps.filter((s) => s.kind === 'COMPENSATION') ?? [],
  );

  /** True once anything was compensated — drives whether we show that table. */
  readonly wasCompensated = computed(() =>
    this.compensationSteps().some((s) => s.status !== 'PENDING'),
  );

  constructor() {
    // Subscribing to paramMap rather than reading snapshot once: Angular reuses
    // this component when navigating between two order ids, and a snapshot read
    // would leave the previous order on screen.
    this.route.paramMap.subscribe((params) => {
      const orderId = params.get('orderId');
      if (orderId) this.load(orderId);
    });
  }

  label(status: OrderStatus): string {
    return STATUS_LABEL[status];
  }

  load(orderId: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getOrder(orderId).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : 'Order not found');
        this.loading.set(false);
      },
    });
  }

  retry(): void {
    const orderId = this.detail()?.order.order_id;
    if (!orderId) return;
    this.busy.set(true);
    this.api.retry(orderId).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(orderId);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(err instanceof Error ? err.message : 'Retry failed');
      },
    });
  }

  markShipped(): void {
    const orderId = this.detail()?.order.order_id;
    if (!orderId) return;
    this.busy.set(true);
    this.api.markShipped(orderId).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(orderId);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(err instanceof Error ? err.message : 'Mark shipped failed');
      },
    });
  }
}
