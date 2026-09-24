# Contributing

Thanks for your interest in improving FreeRouter.

## Development setup

Requirements: Node.js 22 or later.

```bash
git clone https://github.com/David-Raffo/FreeRouter.git
cd FreeRouter
npm install
FREEROUTER_DISABLE_AUTH=true npm run dev
```

The dashboard has its own dev server with hot reload:

```bash
npm run dev --workspace=web
```

It runs on port 5173 and proxies API calls to 8787.

## Before opening a pull request

```bash
npm run build
npm test
```

- Keep pull requests focused on a single change.
- If you touch routing or quotas, add a test that fails without your change.
- Describe what changed and how you tested it.

## Adding or updating a provider

Most providers are data, not code: add or edit an entry in `server/catalog/providers.json`.
Only providers that break the OpenAI-compatible mould need logic in
`server/src/providers/overrides.ts`.

Include a link to the provider's official documentation for its limits, and only add
providers with a genuinely renewing free quota, not one-off welcome credit.

## Reporting bugs

Open an issue using the bug report template. Never paste API keys in issues or logs.
