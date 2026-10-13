# meup-tickets — Worker redirect compatibility fix

Version: `2026-10-13-redirect-fix-1`

This package is for the separate **meup-tickets backend Worker**. It is not a
Cloudflare Drop upload and does not replace your scanner website.

## Apply the fix

1. Replace `worker.mjs` at the root of `lukaaas176/meup-tickets` with the file in
   this package. Do not put it in an extra nested directory.
2. Commit to the branch connected to the **meup-tickets** Worker and deploy that
   new commit. Keep the deploy command `npx wrangler deploy`.
3. Leave the scanner frontend and existing runtime variables/secrets unchanged
   for this fix. Do not put credentials into source files or this archive.
4. Reconnect the scanner in review mode and run its connection check. This
   performs voucher lookups, not expiry updates. Then check one voucher in review
   mode before enabling continuous expiry.

Your existing `wrangler.jsonc` can stay as it is. The supplied version is an
optional replacement using `name: "meup-tickets"`, `main: "worker.mjs"`,
`keep_vars: true`, and enabled observability. Preserve any additional project
settings you have added rather than overwriting them blindly.

## What was wrong

The old Worker passed `redirect: 'error'` to its outbound fetch. Cloudflare's
workerd implementation rejects that option before sending the request. The
old catch handler hid this exception behind a generic HTTP 502.

The essential change is:

```diff
- redirect: 'error'
+ redirect: 'manual'
```

Manual mode is followed by an explicit rejection of 3xx responses. The Worker
never follows a redirect carrying your pretix Authorization token. The
frontend's browser-side fetch is unchanged; this fix targets the Worker only.

The Cloudflare Request reference currently lists `error`, while the runtime
parser rejects it. The implementation source below is the basis for this fix.
A real log with only an HTTP status does not establish every possible upstream
problem; this fixes a concrete incompatibility in the supplied code.

## What else changed

- Authenticated `GET /meta` adds a `version` field. The existing scanner accepts
  this additional field without a frontend update.
- Error responses now contain a diagnostic category and a request ID.
- A matching `pretix_bridge_error` console entry contains only controlled
  diagnostic fields. It omits credentials, voucher codes/IDs, URLs, raw exception
  text and upstream response bodies.
- Timeout exceptions return HTTP 504. Other connection/response exceptions
  return HTTP 502; explicit upstream HTTP error statuses are preserved.
- An unsuccessful expiry response is marked `update_uncertain: true` and advises
  checking the voucher in review mode. There are no automatic retries.

The expiry action still PATCHes only `valid_until` to
`2000-01-01T00:00:00Z`. Authentication, the exact scanner-origin check, the event
allowlist and the permitted operations remain in place.

## Verify which version is deployed

The scanner requests `/meta` when connecting. In browser developer tools,
inspect the response to that request. The corrected version includes:

```json
{"version":"2026-10-13-redirect-fix-1"}
```

There are also `base` and `targets` fields; the above is only the version field.
The endpoint still requires the correct scanner Origin and Bearer key.
Opening it directly in a browser tab is not a valid authenticated test.

## A different error after deployment

Inspect the failed `/voucher` request's **Response** in the browser Network
panel, or look for a `pretix_bridge_error` console entry in Worker logs.
The scanner's existing UI displays generic HTTP errors and does not display
all of the new diagnostic details.

| Diagnostic | Interpretation / next check |
|---|---|
| `UPSTREAM_REDIRECT` | The API returned a 3xx response. Check the canonical pretix API origin; the Worker did not follow the redirect. |
| `UPSTREAM_HTTP` | An HTTP error response arrived from upstream. Inspect `upstream_status`; for example, authentication/permissions, endpoint, or upstream server availability may need checking. |
| `UPSTREAM_INVALID_JSON` | The upstream response was not valid JSON. Check that the API hostname is not a landing page or login portal. |
| `UPSTREAM_DNS` | The runtime exception indicates hostname resolution trouble. |
| `UPSTREAM_TLS` | The runtime exception indicates a TLS/certificate problem. |
| `UPSTREAM_ROUTING` | The exception mentions Cloudflare 1042 or same-zone/account routing. Check the configured upstream and routing. |
| `UPSTREAM_TIMEOUT` | The runtime reported a timeout or abort. A sent expiry may still have been applied. |
| `UPSTREAM_EXCEPTION` | Another fetch/response exception occurred; no specific cause was exposed by the classification. |

DNS/TLS/routing labels classify the runtime's exception text; they are clues,
not independent network measurements. Raw exception text is never exposed.

Share only the error response or the controlled `pretix_bridge_error` entry
for troubleshooting. Do not share Authorization headers, secrets, complete
request exports, or an unredacted HAR file.

## Tests and limitations

Run with Node.js 22 or later:

```bash
node --check worker.mjs
node --test tests/*.test.mjs
```

All 33 tests passed in Node.js 22.16.0. See `TEST-RESULTS.txt`.

The tests use mocked upstream requests. One regression test explicitly models
workerd's allowed redirect values: the old option is rejected before the mock
sends an upstream request, and the corrected option succeeds. Redirect tests
cover 301, 302, 303, 307 and 308, including token/code non-disclosure. Other tests
cover authentication, origin enforcement, target restrictions, exact expiry
payload, error classification and uncertain updates.

These are not tests running in a deployed Cloudflare Worker or the actual
workerd binary. No live pretix requests or voucher modifications were made.
This package has not been deployed to your Cloudflare account.

## Primary references

Checked on 2026-10-13:

- Runtime redirect parsing and rejection:
  https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B
  (`Request::constructor` and `Request::tryParseRedirect`)
- Request redirect handling and Authorization-header warning:
  https://developers.cloudflare.com/workers/runtime-apis/request/
- Worker console / invocation logs:
  https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Wrangler configuration and `keep_vars`:
  https://developers.cloudflare.com/workers/wrangler/configuration/
