# Hosting integration setup

This update adds website provisioning and per-customer start, stop and restart controls. Payments stay closed until a real hosting test succeeds. Existing Discord login and Stripe configuration remain unchanged.

## Environment variables

Keep existing variables. Add these as literal runtime values (buildtime off):

- `COOLIFY_API_URL`: API origin, without `/api/v1`. For a panel container on Coolify's shared management network this is normally `http://coolify:8080`; test with the dashboard connection-check button. Do not send the token over the public HTTP management address.
- `COOLIFY_API_TOKEN`: read/write/deploy/delete token, limited to the hosting project. Delete is required for the instance-removal feature. Sensitive-read/root permissions are not needed.
- `COOLIFY_PROJECT_UUID`: customer-bot project UUID from its Coolify URL.
- `COOLIFY_SERVER_UUID`: selected server UUID from its Coolify URL.
- `COOLIFY_ENVIRONMENT_NAME`: `production`, unless using another environment.
- `COOLIFY_DESTINATION_UUID`: optional; required if that server has several destinations.
- `MODMAIL_IMAGE`: reviewed upstream Modmail image pinned by full sha256 digest. A mutable tag is rejected. Its `bot` Python module must expose `ModmailBot` and `main` (the supplied Modmail code does). Build a reviewed image from the desired repository if the upstream published image differs.
- `HOSTING_ENABLED`: leave `false` during configuration. Set `true` only for the private test after image review.
- `HOSTING_TEST_DISCORD_ID`: your Discord user ID, shown on the signed-in dashboard. While commerce is off, only this exact account gets one free test slot. No other user gets free slots. Remove after testing.
- `MAX_BOT_INSTANCES`: default `5`; includes failed/reserved instances. Set conservatively after checking actual server RAM/CPU and existing workload.
- `COMMERCE_ENABLED`: keep `false` until end-to-end deployment, renewals and cancellations have been verified.

## Runtime restrictions

Customers supply a name, server ID and bot token; arbitrary env, code, commands and image sources are not accepted. Discord application ownership is checked against the signed-in account. Customers must enable required privileged intents and invite their bot to their server themselves.

A runtime bootstrap disables the plugins cog and rejects code-execution, debug, update, config and OAuth owner commands. This bootstrap must be tested against the exact image digest. It is defense in depth, not a security audit of Modmail or its dependencies. Each service has a private MongoDB volume/network, generated password, resource caps and no published database ports. It is not attached to the shared Coolify network. Containers have no added capabilities or Docker socket access. MongoDB runs as uid/gid 999 and needs its named volume writable by that UID.

The current prototype stores threads but does not expose a logviewer. Generated log links show an explicit unavailable message. Private thread-log viewing remains outstanding. The panel now supports signed Discord commands for status and lifecycle controls, with private website links for deployment and editing; see RELEASE_SETUP.md.

## Failure handling

Bot tokens and database passwords are sent directly to Coolify's locked literal service environment settings; they are not kept in the panel SQLite database or returned in API responses. A service creation timeout can be ambiguous. Failed creations retain their reservation and show `needs_attention`; an operator must inspect and reconcile the named `offsettech-<id>` service before releasing any reservation. Customer deletion now queues service removal, retaining database volumes; its slot is freed only after the provider reports removal. Retained storage needs operator monitoring and a cleanup policy. Stopping a bot retains its slot and database.

A start/restart response means Coolify queued an operation, not that the bot is connected to Discord. Check Coolify and the bot's actual Discord presence during the private test. Status labels reconcile observed container health with queued operations; a restart needs an observed transition before it is confirmed. Container health does not prove a Discord Gateway connection.

Subscription reconciliation runs every five minutes, on account refresh and on relevant Stripe webhooks. Excess instances are stopped, with oldest instances retaining paid slots. Stripe outages do not revoke access automatically. No automatic deletion occurs. Provider credentials, scope, connectivity and database backups need operational monitoring.

## Validation performed

Unit tests cover templates without embedded credentials, slot enforcement before provider calls, provisioning, cross-user ownership isolation, expiry suspension, restart rejection without a slot, ambiguous-creation reservation and missing configuration. Existing Stripe signature and entitlement tests remain included. Private provisioning and sandbox checkout have been exercised during setup. New edit/delete operations and Discord command registration still need live checks after deployment. See RELEASE_SETUP.md for the staff and owner sign-in configuration.
