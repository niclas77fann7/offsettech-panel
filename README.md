# OffsetTech control panel

Prepared backend for deployment to Contabo with Coolify. The existing ChatGPT Site is an interactive preview; this app runs separately and requires its own HTTPS origin.

## Implemented

- Discord authorization-code login using the identify scope, one-use state, HttpOnly secure cookies and server-side expiring sessions.
- Monthly/yearly Stripe Checkout with server-allowlisted prices and quantity 1–100.
- Stripe billing portal; signed webhook verification with timestamp tolerance and event deduplication.
- Account slot totals checked against Stripe, with only paid, recognized, unexpired subscription items granting access. Cancellation at the end of the paid period retains access until that period ends.
- SQLite persistence; use a single application replica and persistent /data storage.
- No bot-token collection, Coolify bot provisioning or Discord slash-command handlers yet. Paid slot reduction is reflected in the account but deployment suspension is not implemented. Checkout remains disabled until these are completed.

## Coolify deployment

1. Put the contents of this directory into a private GitHub repository.
2. In Coolify create a new application from that repository, choosing Dockerfile build and port 3000. Add a persistent volume mounted at /data. Use one replica.
3. Assign an HTTPS hostname. Set PUBLIC_URL to that exact origin with no trailing slash.
4. Add variables from .env.example in Coolify. Mark DISCORD_CLIENT_SECRET, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET as secrets. Do not commit actual .env files or keys.
5. Discord OAuth2 redirect: PUBLIC_URL/api/auth/discord/callback. The preview Site callback previously registered must be replaced with this actual backend address.
6. In Stripe create a webhook destination pointing to PUBLIC_URL/api/stripe/webhook. Select checkout.session.completed, checkout.session.async_payment_succeeded, invoice.paid, invoice.payment_failed, customer.subscription.created, customer.subscription.updated and customer.subscription.deleted. Put that destination's signing secret into STRIPE_WEBHOOK_SECRET.
7. Enable the Stripe customer portal to let customers cancel at period end and manage payment methods. Configure any quantity/plan changes deliberately. Adding slots on this website creates an additional subscription.
8. Keep COMMERCE_ENABLED=false until bot provisioning is integrated and tested. Current frontend deliberately blocks checkout too. No payment-provider secrets have been configured.

## Testing

Run `npm test` on Node 24. Tests cover exact raw webhook signatures, replay timestamps, invalid signatures, paid/unpaid subscription access, unfamiliar prices and cancellation at period end.

Use Stripe sandbox/test credentials and matching test price IDs first. The prefilled price IDs supplied by the owner are from their live dashboard; test mode needs separately created prices. Test Discord login, checkout, duplicate webhook delivery, payment failure, renewals, cancellation and cross-user isolation before opening checkout. This version has unit tests and a local HTTP smoke test; it has not been tested against real provider credentials.

Secure sessions require HTTPS. Run behind Coolify's HTTPS proxy. Keep SQLite backed up. Do not scale to multiple replicas without replacing the local database and in-process locks.
