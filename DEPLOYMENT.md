# meup-tickets: separate Cloudflare Worker deployment fix

This is the API bridge only. Keep the scanner website at its existing URL.
The worker.mjs in this bundle is unchanged from the previously supplied
pretix-cloudflare-drop.zip. The new wrangler.jsonc declares its entry point.
No credentials or event slugs are included.

## Apply to the existing GitHub repository

Only wrangler.jsonc is needed to correct the missing-entry-point deployment
configuration. Add it at the repository root beside your existing worker.mjs.
Do not put it in an optional-worker subdirectory.

The configured Worker name is meup-tickets. Change the name in wrangler.jsonc
if the existing Worker has a different name in your Cloudflare dashboard.
It must match the Cloudflare Worker, not necessarily the GitHub repository.

Commit to the branch connected to Cloudflare (normally main). Alternatively,
extract this entire ZIP and commit its files at the repository root. Do not
commit the ZIP itself as a substitute for these files, and do not upload this
backend bundle to Cloudflare Drop.

## Cloudflare build settings

Open the separate Worker, then Settings > Build > Build configuration.

- Root directory: repository root (leave the optional field empty).
- Build command: empty; this plain JavaScript Worker needs no separate build.
- Deploy command: npx wrangler deploy

Do not add an assets directory or an --assets flag. This Worker has no static
website to publish. The main field selects worker.mjs as executable code.
Commit the configuration and deploy the NEW commit. Retrying an old commit
that did not contain the file will not include it.

## Runtime variables and secrets

Use the Worker's Settings > Variables and Secrets. Do NOT put these only in
Settings > Build > Build variables and secrets; build-only values are not
available to the running Worker.

Text variables:

PRETIX_BASE_URL
  The HTTPS origin of your actual pretix API server. For example only:
  https://pretix.example.org
  Use your real server, without /api/v1, an organizer/event path, or /control.
  The printed coupon's landing-page hostname is not necessarily the API server.

ALLOWED_TARGETS
  Comma-separated organizer/event slug pairs, for example only:
  my-organizer/event-one,my-organizer/event-two
  Use your real slugs. Include each event the scanner is allowed to change.

SCANNER_ORIGIN
  The exact HTTPS origin of the scanner website you deployed earlier: scheme
  and hostname only, with no path/query/fragment. Use the site's final address,
  not the Worker address and not the printed QR-code landing-page address.

Secrets (select type Secret in the dashboard):

PRETIX_TOKEN
  Your pretix team API token, without the "Token " prefix.

SCANNER_KEY
  A separate randomly generated key, at least 32 characters, with no whitespace.
  For example, generate 32 random bytes locally with a password manager or:
      python -c "import secrets; print(secrets.token_hex(32))"
  Do not reuse a public example or your pretix token as this key.

Save/deploy the runtime settings. The keep_vars setting preserves dashboard-
managed plaintext variables on later Wrangler deploys. Secrets remain in
Cloudflare; never commit their values to GitHub or put them in this ZIP.

## Connect the scanner

Select Worker bridge mode in the existing scanner. Enter the deployed Worker's
HTTPS origin and the same SCANNER_KEY. The pretix token stays on the Worker.
Test connection and review one expendable voucher before using continuous mode.

Opening the Worker directly in a browser is not a suitable connection test:
with valid settings it rejects requests lacking the scanner Origin with 403
"Origin not allowed." Missing or invalid settings return 503
"Bridge is not configured. Check its variables and secrets."

## Validation and scope

This package's JSON configuration and basic handler behavior were checked
locally using Node.js and fake credentials. No real pretix requests were made.
No changes have been pushed to GitHub and no Cloudflare deployment was run.
The configuration fixes the missing Worker entry point; real account settings,
credentials, permissions and connectivity still require a deployment test.

## Sources checked 13 October 2026

Repository inspected:
https://github.com/lukaaas176/meup-tickets

Wrangler configuration (main, compatibility_date, keep_vars):
https://developers.cloudflare.com/workers/wrangler/configuration/

Build settings and build-only versus runtime variables:
https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

Worker name matching and deployment troubleshooting:
https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/

Runtime secrets:
https://developers.cloudflare.com/workers/configuration/secrets/
