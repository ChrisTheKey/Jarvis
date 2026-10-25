# Stripe Integration – Setup-Referenz (TF-081)

Keine Secret-Werte in dieser Datei – nur Namen von Umgebungsvariablen.

## Scenario

**Scenario A – existing Checkout Session integration.**

Jarvis creates Checkout Sessions server-side via the raw Stripe REST API (`POST /v1/checkout/sessions`, no SDK, no Express)
in `stripe-payments.js` → `createCheckoutSession()`, called by the Repair service (`stripe-webhook.js`). The Checkout Studio
settings were applied surgically to that existing call. No second endpoint, webhook, or architecture was added.

Jarvis sends **no `Stripe-Version` header**, so the Stripe account's default API version applies. The version is deliberately
not pinned or guessed. That's why only parameters valid on every API version are sent.

## Configured Parameters

Sent on every Checkout Session (`CHECKOUT_STUDIO` in `stripe-payments.js`):

| Parameter | Value |
| --- | --- |
| `billing_address_collection` | `auto` |
| `phone_number_collection[enabled]` | `false` |
| `automatic_tax[enabled]` | `false` |
| `allow_promotion_codes` | `false` |
| `submit_type` | `auto` |

Deliberately **not sent**:

| Parameter | Status | Reason |
| --- | --- | --- |
| `ui_mode` | intent = hosted, **not sent** | Version-dependent enum. Before `2026-03-25.dahlia` the value is `hosted`. From dahlia on, `hosted` was removed (requests with it are rejected) and replaced by `hosted_page`. Without a pinned version, either value can break every Checkout. The Stripe default in **all** versions is the hosted page, so leaving it out is the same as "hosted". Jarvis also checks the response: `ui_mode` must be `hosted`/`hosted_page` (or absent), otherwise `BAD_RESPONSE` (fail closed). |
| `integration_identifier` (`hosted_web_0001`) | **UNSUPPORTED** (for the unpinned version) | Exists only from API version `2026-03-25.dahlia`. On older account versions Stripe rejects the unknown parameter. Pinning the version is forbidden (TF-081 §5). |
| `origin_context` (`web`) | **UNSUPPORTED** (for the unpinned version) | Exists only from API version `2025-07-30.basil`. Same reason. |
| `payment_method_collection` | not applicable | Only allowed in `subscription` mode. Jarvis uses `mode=payment`. |
| `payment_method_types` | not set | Payment methods come from the Stripe account (dynamic payment methods: card, TWINT, … if enabled there). |

To activate later (only after a deliberate API-version upgrade): send `ui_mode=hosted_page`, `integration_identifier=hosted_web_0001`
and `origin_context=web`, or pin `Stripe-Version` explicitly. Do this only together with a webhook version check and a test-mode trial.

Sources: Stripe API reference *Create a Checkout Session*. Changelog `2026-03-25.dahlia` «updates-available-checkout-session-ui-modes»
and «adds-integration-identifier-parameter-to-checkout-sessions». Changelog `2025-07-30.basil` «checkout-origin-context».

## Existing Dynamic Values

These are real Jarvis values, **not placeholders** (no `price_…`, no `example.com`, no hard-coded test price):

- `mode` = `payment`
- `success_url` = `<origin>/zahlung.html?s=ok` (TEST: `&m=test`). The return page is never proof of payment.
- `cancel_url` = `<origin>/zahlung.html?s=abbruch` (TEST: `&m=test`)
- `line_items[0]` = server-side `price_data`: `currency=chf`, `unit_amount=24000` (deposit = first half of the REPAIR_FIX_500 fixed price
  CHF 480 from `pricing.js`), `quantity=1`, product name with order ID (TEST: prefixed «TESTZAHLUNG –»)

## Jarvis Security Parameters

Intentionally kept. The generic Studio rule "remove anything not in the Field Intents" does **not** apply here (TF-080 security model):

- `client_reference_id` = Jarvis order ID. Binds the session to exactly one order.
- `metadata` (`order_id`, `offer_class`, `market`, `purpose=REPAIR_DEPOSIT`, `environment=LIVE|TEST`). Used for webhook/reconciliation
  checks (wrong order/purpose/mode → no booking) and for LIVE/TEST separation.
- `payment_intent_data[metadata]` + `payment_intent_data[description]`. Match refunds/disputes (charge/PaymentIntent) to the order.
- `expires_at` = creation + 23 h. Expired links are replaced exactly once, then `EXPIRED_FINAL`.
- `customer_email` (only when the order has a delivery address). Pre-fills Checkout.
- `locale=de`
- Idempotency key `jarvis:<order>:deposit:v1:<mode>[:rN]` (header). A restart or second run never creates a second session.

Booking happens only through `payments.js` (canonical ledger), after a signed webhook or authoritative reconciliation. Session, mode, order,
purpose, CHF and 24000 minor units are all checked. The browser redirect alone never opens the payment gate.

## External Setup Remaining

- `STRIPE_SECRET_KEY` (LIVE, `sk_live_…`/`rk_live_…`) on the VPS in `/opt/jarvis-payment/stripe.env`
  (`deploy/vps/install-stripe-keys.sh fiverr live`, hidden input)
- `STRIPE_TEST_SECRET_KEY` (TEST, `sk_test_…`/`rk_test_…`) same place (`install-stripe-keys.sh fiverr test`)
- `STRIPE_WEBHOOK_SECRET` (LIVE) in Netlify env (`/api/payments`)
- `STRIPE_TEST_WEBHOOK_SECRET` (TEST) in Netlify env
- Enable TWINT in the Stripe dashboard if wanted (no code change needed)
- Set up LIVE and TEST webhook endpoints → `https://chrisjarvis.netlify.app/api/payments`, events `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
  `charge.dispute.created`
