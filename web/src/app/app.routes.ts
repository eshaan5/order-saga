import { Routes } from '@angular/router';

/**
 * Replaces $routeProvider / ui-router.
 *
 * `loadComponent` lazy-loads: the detail page's JavaScript is only fetched
 * when you actually navigate to an order, instead of being bundled into the
 * initial download. One line, and it's what keeps a growing app fast.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/order-list/order-list').then((m) => m.OrderList),
  },
  {
    path: 'orders/:orderId',
    loadComponent: () =>
      import('./features/order-detail/order-detail').then((m) => m.OrderDetail),
  },
  { path: '**', redirectTo: '' },
];
