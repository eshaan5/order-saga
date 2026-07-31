import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { Api } from '../../core/api';
import {
  ALL_STATUSES,
  STATUS_LABEL,
  type OrderListItem,
  type OrderStatus,
  type Stats,
} from '../../core/models';

@Component({
  selector: 'app-order-list',
  // Standalone: the component lists exactly what its template uses. Anything
  // missing is a compile error, not a silently-broken directive.
  imports: [RouterLink, DatePipe],
  templateUrl: './order-list.html',
  styleUrl: './order-list.css',
})
export class OrderList {
  private api = inject(Api);
  private destroyRef = inject(DestroyRef);

  // ---- state -------------------------------------------------------------
  // Every one of these is a signal, not a plain property. Angular 22 is
  // zoneless: assigning `this.orders = x` would update the field and never
  // re-render. `orders.set(x)` is what schedules the update.
  readonly orders = signal<OrderListItem[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly statusFilter = signal<OrderStatus | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly stats = signal<Stats>({});
  readonly autoRefresh = signal(false);
  /** Which row currently has an action in flight, so we can disable its buttons. */
  readonly busyOrderId = signal<string | null>(null);

  // computed() re-evaluates only when a signal it READ changes. It tracks that
  // dependency automatically — this is what replaces $scope.$watch.
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  readonly statuses = ALL_STATUSES;

  constructor() {
    this.load();
    this.loadStats();

    // Polling makes the bulk run watchable. DestroyRef is the modern
    // ngOnDestroy — without the cleanup this interval would outlive the
    // component and keep firing requests after you navigate away.
    const timer = setInterval(() => {
      if (this.autoRefresh()) {
        this.load();
        this.loadStats();
      }
    }, 2000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  label(status: OrderStatus): string {
    return STATUS_LABEL[status];
  }

  count(status: OrderStatus): number {
    return this.stats()[status] ?? 0;
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);

    const status = this.statusFilter();
    this.api
      .listOrders({
        ...(status ? { status } : {}),
        page: this.page(),
        pageSize: this.pageSize(),
      })
      // Observables are lazy — nothing is sent until subscribe().
      .subscribe({
        next: (page) => {
          this.orders.set(page.items);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(err instanceof Error ? err.message : 'Failed to load orders');
          this.loading.set(false);
        },
      });
  }

  loadStats(): void {
    this.api.getStats().subscribe({
      next: (s) => this.stats.set(s),
      error: () => { /* the stats strip is decorative; don't fail the page over it */ },
    });
  }

  setStatus(status: OrderStatus | null): void {
    this.statusFilter.set(status);
    this.page.set(1); // filtering while on page 12 would show an empty table
    this.load();
  }

  goTo(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    this.load();
  }

  toggleAutoRefresh(): void {
    // update() rather than set() when the new value derives from the old.
    this.autoRefresh.update((on) => !on);
  }

  /** Requirement 7 — re-run a compensation that exhausted its retries. */
  retry(orderId: string, event: Event): void {
    event.stopPropagation(); // the row is a link; don't navigate on button click
    this.busyOrderId.set(orderId);
    this.api.retry(orderId).subscribe({
      next: () => {
        this.busyOrderId.set(null);
        this.load();
        this.loadStats();
      },
      error: (err: unknown) => {
        this.busyOrderId.set(null);
        this.error.set(err instanceof Error ? err.message : 'Retry failed');
      },
    });
  }

  markShipped(orderId: string, event: Event): void {
    event.stopPropagation();
    this.busyOrderId.set(orderId);
    this.api.markShipped(orderId).subscribe({
      next: () => {
        this.busyOrderId.set(null);
        this.load();
        this.loadStats();
      },
      error: (err: unknown) => {
        this.busyOrderId.set(null);
        this.error.set(err instanceof Error ? err.message : 'Mark shipped failed');
      },
    });
  }
}
