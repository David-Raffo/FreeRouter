# Security Policy

## Supported versions

Only the latest version on the `main` branch receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
[GitHub Security Advisories](https://github.com/David-Raffo/FreeRouter/security/advisories/new).

You can expect an initial response within a few days.

## Deployment recommendations

- Always set a strong `FREEROUTER_PASSWORD`; only use `FREEROUTER_DISABLE_AUTH=true` when
  the port is bound to `127.0.0.1`.
- Expose the service to the internet only over HTTPS, using the `https` or `tunnel`
  Docker Compose profiles, with `FREEROUTER_BIND=127.0.0.1` and `FREEROUTER_HTTPS=true`.
- Back up the `freerouter-data` volume: it contains the master key needed to decrypt the
  stored provider keys.
