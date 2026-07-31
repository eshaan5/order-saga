# Web UI

Angular 22 front end for the order processing system.

**See the [root README](../README.md) for setup and how to run the whole system.**

```bash
npm install
npm start      # http://localhost:4200
npm test       # component tests (vitest)
npm run build
```

`/api` is proxied to the coordinator on `http://localhost:3000` via
[proxy.conf.json](proxy.conf.json), so every API URL in the code is relative and works unchanged
behind a reverse proxy in production.

## Screens

- **Order list** — paginated, filterable by status, shows steps completed, with **Retry undo**
  on needs-attention orders and **Mark shipped** on placed ones.
- **Order detail** — every step with its retry count, the undo steps if the order was cancelled
  (including the ones marked `SKIPPED` because that forward step never succeeded), and the full
  per-attempt log.

## Notes

Angular 22 is **zoneless** — there is no `zone.js` dependency. Change detection is driven by
signals, template events and the async pipe, so any state the template reads must live in a
`signal()`. Assigning a plain class property in a subscribe callback will not re-render.
