import type { Types } from 'mongoose';
import type { NormalisedOrder } from '@anton/shared';
import type { OrderSource } from './types.js';

/**
 * Shopify OAuth adapter — DELIBERATELY NOT IMPLEMENTED.
 *
 * This file exists to hold the seam open and to record what implementing it
 * actually involves, so the decision to build it is made with the cost visible
 * rather than discovered halfway through.
 *
 * TODO, when it is time:
 *
 *  1. App registration and OAuth. A public Shopify app needs a listing, an
 *     OAuth callback, and Shopify's own review. Scopes: read_orders. Note that
 *     read_orders only reaches 60 days of history without `read_all_orders`,
 *     which requires separate approval and a stated reason.
 *
 *  2. Token storage. Per-shop offline access tokens, encrypted at rest, with a
 *     revocation path. These are credentials to the brand's whole order book;
 *     they belong nowhere near the same store as ordinary config.
 *
 *  3. Webhooks over polling. orders/create, orders/updated, refunds/create.
 *     Verify the HMAC on every delivery before parsing the body. Webhooks are
 *     at-least-once, so the handler must be idempotent — which the existing
 *     commit path already is, and is the reason it was built that way.
 *
 *  4. Pagination. Cursor-based via the Link header; page sizes cap at 250.
 *
 *  5. Money. Shopify returns decimal strings with a currency alongside. Route
 *     them through parseMoneyString rather than Number() — the existing parser
 *     already refuses the ambiguous forms, and Number() would not.
 *
 *  6. Refunds are separate objects, not a field on the order. A refund arrives
 *     as its own event and must be folded onto the order it belongs to before
 *     the reversal is computed.
 *
 *  7. GDPR webhooks are mandatory for a listed app: customers/redact,
 *     shop/redact, customers/data_request. Refusing to implement them is not an
 *     option for a public app.
 *
 * Until all of that exists, this adapter refuses rather than returning an empty
 * array — an empty array would read as "the brand had no orders", which is a
 * different and much worse claim than "this is not built".
 */
export const shopifyOAuthSource: OrderSource = {
  id: 'shopify_oauth',
  label: 'Shopify (OAuth)',
  canPoll: true,

  async fetchOrders(
    _brandId: Types.ObjectId,
    _since: Date | null,
    _until: Date | null,
  ): Promise<NormalisedOrder[]> {
    throw new Error(
      'The Shopify OAuth source is not implemented. Orders arrive by CSV upload until it is.',
    );
  },
};
