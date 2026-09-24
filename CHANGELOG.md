# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- English README, with the Spanish version moved to `README.es.md`.
- Continuous integration, contribution guide, security policy and issue templates.

### Fixed

- Flaky gateway test that depended on a fixed delay for asynchronous key revalidation.

## [0.1.0] - 2026-09-24

### Added

- OpenAI-compatible `/v1/chat/completions` and `/v1/responses` endpoints with automatic model selection.
- 24 free inference providers defined as data in `server/catalog/providers.json`.
- Quality and speed scoring with `rapido`, `balanceado` and `calidad` profiles.
- Preventive quota tracking, growing 429 penalties and automatic failover.
- Dashboard for model status, request history, provider credentials and API keys.
- AES-256-GCM encryption of provider keys and mandatory dashboard password.
- Docker Compose deployment with `https` (Caddy) and `tunnel` (Cloudflare) profiles.

[Unreleased]: https://github.com/David-Raffo/FreeRouter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/David-Raffo/FreeRouter/releases/tag/v0.1.0
