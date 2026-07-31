import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

/**
 * Root shell. Just a header and the outlet the router renders into.
 *
 * `imports: [...]` on the component itself is the standalone model — in
 * AngularJS you'd have registered directives on a module and hoped they were
 * loaded. Here a component declares exactly what its own template uses, and
 * anything not listed is a compile error rather than a blank screen.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
