import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

/**
 * Replaces AngularJS's `angular.module('app', [...])` + `.config()`.
 *
 * Note there is no `provideZoneChangeDetection` and no zone.js dependency:
 * Angular 22 is ZONELESS. Change detection is driven by signals, template
 * events and the async pipe — not by patching every setTimeout and XHR.
 *
 * Practical consequence: assigning a plain class property inside a subscribe
 * callback will NOT reliably re-render. Anything the template reads must live
 * in a signal. That's why every component here uses them.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // withFetch() uses the native fetch API instead of XMLHttpRequest.
    provideHttpClient(withFetch()),
  ],
};
