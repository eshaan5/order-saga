/**
 * The only place that talks to the backend.
 *
 * AngularJS equivalent would be an `.factory('Api', function ($http) {...})`.
 * Differences:
 *   - it's a class, and the class itself is the DI token (no string names)
 *   - `providedIn: 'root'` registers it app-wide; no module wiring
 *   - HttpClient returns an Observable, not a promise. Observables are LAZY:
 *     nothing happens until .subscribe(). If a request never fires, that's
 *     almost always why.
 *
 * URLs are relative ("/api/..."), not absolute. In dev, proxy.conf.json
 * forwards /api to localhost:3000; in production the same paths work behind a
 * reverse proxy. Hardcoding http://localhost:3000 would work today and break
 * the moment this is deployed anywhere.
 */

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { OrderDetail, OrderListPage, OrderStatus, Stats } from './models';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  listOrders(options: { status?: OrderStatus; page: number; pageSize: number }) {
    const params: Record<string, string> = {
      page: String(options.page),
      pageSize: String(options.pageSize),
    };
    if (options.status) params['status'] = options.status;

    return this.http.get<OrderListPage>('/api/orders', { params });
  }

  getOrder(orderId: string) {
    return this.http.get<OrderDetail>(`/api/orders/${orderId}`);
  }

  getStats() {
    return this.http.get<Stats>('/api/stats');
  }

  /** Requirement 7 — re-run a compensation that exhausted its retries. */
  retry(orderId: string) {
    return this.http.post<{ ok: boolean; orderId: string; status: OrderStatus }>(
      `/api/orders/${orderId}/retry`,
      {},
    );
  }

  /** The only thing that produces SHIPPED — nothing in the saga does. */
  markShipped(orderId: string) {
    return this.http.post<{ ok: boolean; orderId: string; status: OrderStatus }>(
      `/api/orders/${orderId}/mark-shipped`,
      {},
    );
  }
}
