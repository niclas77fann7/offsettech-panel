# OffsetTech control panel

Discord bot hosting on Contabo, managed through Coolify. The Node 24 server provides a public landing page, a private dashboard, Stripe subscriptions, bot lifecycle controls and a staff console.

## Included

- Discord sign-in with one-use OAuth state and expiring secure server sessions; optional owner password sign-in configured privately at runtime.
- Public `/` landing page, `/signin`, setup guide and authenticated `/dashboard` and `/staff` routes.
- Stripe monthly/yearly subscriptions, quantity-based slots, billing portal, signed and deduplicated webhooks, separate sandbox customer records and paid-slot reconciliation.
- Approved Modmail provisioning with an individual MongoDB instance, generated database password and persistent volume for each bot. Application ownership is checked against Discord before deployment.
- Customer start, stop, restart, configuration editing and instance deletion. Provider container states are reconciled with pending actions. Deletion retains database volumes and waits for provider removal before freeing a slot.
- Owner-controlled staff membership, granular permissions, revocation/restoration and audit history. Default staff presets cannot create staff.
- Signed Discord HTTP interactions: private `/status`, `/start`, `/stop` and `/restart`; private dashboard links from `/deploy`, `/edit`, `/delete`, `/billing` and `/staff`.

See [RELEASE_SETUP.md](RELEASE_SETUP.md) for owner login, staff permissions, Discord registration and the upgrade steps. See [HOSTING_SETUP.md](HOSTING_SETUP.md) for the provider configuration and runtime restrictions.

## Deployment

Use Coolify's Dockerfile build, port `3000`, one replica, and persistent storage mounted at `/data`. Set `PUBLIC_URL` to the exact HTTPS origin without a trailing slash. Set variables from [env.example](env.example) privately in Coolify; secrets belong in runtime environment settings, never source control.

Discord OAuth redirect: `PUBLIC_URL/api/auth/discord/callback`.

Stripe webhook: `PUBLIC_URL/api/stripe/webhook`, listening to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Enable Stripe's customer portal for subscription management. Use sandbox credentials and matching sandbox price IDs with `STRIPE_TEST_MODE=true`; only the configured test operator can access checkout while public commerce is closed. Keep `COMMERCE_ENABLED=false` until the full lifecycle, billing failures and cancellation behavior have been checked.

Secure cookies require HTTPS through the Coolify proxy. SQLite and in-process locks require a single replica. Back up `/data` and customer databases separately.

## Verification

Run `npm test` with Node 24. The suite covers actual HTTP authentication and route protection, CSRF, staff delegation, provider operations using mocked APIs, Discord request signatures and Stripe entitlements. New provider edit/deletion and Discord registration features need private live checks after the upgrade. Private thread-log viewing and automated recovery of retained database volumes are not included.
