# Landing page, staff console and Discord commands

## Deploy this update

Redeploy `offsettech-panel` from the latest `main` commit in Coolify. Keep the existing `/data` persistent storage and all Stripe, Discord OAuth and hosting variables. Database tables are created automatically; existing accounts, subscriptions and bots stay in place.

The public home page is now `/`. `/dashboard` and `/staff` require a session. Customers without staff permissions cannot open the staff console or its API.

## Owner access

The owner is Discord user `818142433845706753`. Sign in with that Discord account to use the staff section immediately. Staff use their own Discord sign-in; no shared staff password is needed.

For the optional owner username/password sign-in, add these **literal runtime** environment variables in Coolify, with buildtime disabled:

```dotenv
OWNER_DISCORD_ID=818142433845706753
STAFF_OWNER_USERNAME=myriad6969
STAFF_OWNER_PASSWORD=enter-a-private-password-here
```

Enter the password directly in Coolify, keep its value hidden, and redeploy. No password is embedded in source. If the password variable is absent, Discord sign-in still works and password sign-in is disabled. Password login creates an eight-hour secure session, is rate limited and is recorded in the audit log.

## Staff permissions

In **Staff → Team**, add a member using their Discord user ID. Presets are:

| Role | Default access |
| --- | --- |
| Support | View instances and audit history |
| Operator | Support access, edit/control instances, revoke/restore hosting |
| Admin | Operator access, delete instances, configure Discord commands |
| Owner | All permissions; owner identity cannot be reassigned in the console |

None of the presets can add staff. The owner must explicitly enable **Add and edit staff** for another person. They can then grant only permissions they already hold. **Delegate staff-management access** additionally allows them to pass staff-management rights to other people. Staff cannot change their own access or edit members with broader permissions. Changes take effect on the next request, including for existing sessions.

## Discord commands

No panel gateway process or extra bot token is required. Commands use Discord's signed HTTP interactions:

1. Open the panel application in the Discord Developer Portal → **General Information**. Copy its **Public Key** into the Coolify runtime variable `DISCORD_PUBLIC_KEY`, then redeploy. Keep the existing client ID and client secret.
2. In the same application's **Interactions Endpoint URL**, save the endpoint shown in **Staff → Discord**: your HTTPS origin followed by `/api/discord/interactions`. Discord will verify it with a signed ping.
3. Click **Register commands** in **Staff → Discord**, then use the installation link there to add the application's commands to your server. Registration upserts this panel's command names, leaving other names untouched.

| Command | Behavior |
| --- | --- |
| `/status` | Privately shows your slots and observed bot states |
| `/start bot`, `/stop bot`, `/restart bot` | Controls your own instance using its exact name or dashboard ID |
| `/deploy` | Links to your private deployment form |
| `/edit`, `/delete` | Links to private bot management and confirmations |
| `/billing` | Opens your billing tab |
| `/staff` | Opens the console if your account has staff access |

Replies are private. Bot tokens are entered on the HTTPS website, not as slash-command options. Users must first sign in to the website with Discord so their account and subscriptions are linked. Global commands may take time to appear after registration.

## Bot changes and deletion

Customers can edit their bot's display name, server ID and token. A replacement token must belong to the same Discord bot application and original application owner. Configuration changes restart running instances; name-only changes do not. Each instance keeps its separate MongoDB container, credentials, network and persistent volume.

Revocation queues a stop and blocks customer lifecycle controls until staff restore access. Restoring access does not automatically start the bot or override paid-slot checks.

Deleting removes the hosted service and frees its slot only after the provider reports that the service is gone. The request explicitly retains database volumes and disables Docker cleanup. There is no automatic database restore or retention cleanup in this release: operator recovery and storage management remain manual. Deleting a bot **does not cancel Stripe subscriptions**; use the billing portal for that.

The Coolify token needs `read`, `write`, `deploy` and now `delete` permissions for the corresponding actions, restricted to the hosting project and environment. `root` and `read:sensitive` are not required. Keep the API origin internal. Confirm the token can reach newly created services in that environment.

## Verification and remaining live checks

Run `node --test *.test.mjs` with Node 24. Tests exercise HTTP sign-in, private route gating, CSRF, staff delegation and immediate access removal, exact Discord signatures, webhook entitlement handling, provider lifecycle handling, edit ownership and volume-preserving deletion using synthetic data and mocked providers.

Browser review covers the landing page, dashboard, bot edit dialog and staff permission editor using local sample data. New Coolify edit/delete operations and registered Discord commands still need a private live test after deployment. Keep public checkout closed until renewals, failed payments and cancellations have also been tested. Private thread-log viewing is not included.
