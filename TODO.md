# Follow-ups

- [ ] Enable application-token authentication as defense in depth for remote access.
  Keep Dev Tunnels owner-only (no anonymous or tenant-wide grants), and keep the daemon
  bound to loopback. Configure `COPILOT_SESSIONS_TOKEN` securely without committing or
  logging the secret, account for desktop/browser/updater login, and coordinate the
  daemon restart with the user. Deferred by request; do not change access automatically.
