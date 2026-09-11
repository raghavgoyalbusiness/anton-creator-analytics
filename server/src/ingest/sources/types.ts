import type { NormalisedOrder, OrderSourceId } from '@anton/shared';
import type { Types } from 'mongoose';

/**
 * Where orders come from.
 *
 * The discriminator is the seam. Today there is one adapter; when Shopify OAuth
 * arrives it implements this interface and the ingest pipeline, the attribution
 * engine and the ledger are untouched. Orders already ingested by CSV stay
 * valid and comparable — their `source` says how they arrived.
 */
export interface OrderSource {
  readonly id: OrderSourceId;
  readonly label: string;
  /**
   * Whether this adapter can be driven on a schedule.
   *
   * A CSV cannot: it needs a human to export and upload. Saying so explicitly
   * stops the scheduler from being written against an adapter that can never
   * satisfy it.
   */
  readonly canPoll: boolean;

  fetchOrders(
    brandId: Types.ObjectId,
    since: Date | null,
    until: Date | null,
  ): Promise<NormalisedOrder[]>;
}

/** Raised when an adapter is asked for something it structurally cannot do. */
export class SourceNotPollableError extends Error {
  constructor(sourceId: OrderSourceId) {
    super(
      `The ${sourceId} source cannot be polled — orders arrive by upload. ` +
        'Use the ingest endpoints instead of a scheduled fetch.',
    );
    this.name = 'SourceNotPollableError';
  }
}
