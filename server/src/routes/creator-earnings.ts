import { Router } from 'express';
import { Types } from 'mongoose';
import { formatMoney, percentFromBps, toCsv } from '@anton/shared';
import { AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { OrderModel } from '../db/models/Order.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { BrandModel, CampaignModel } from '../db/models/index.js';
import { getSession, requireCreator } from '../lib/creator-session.js';
import { asyncRoute } from '../lib/validate.js';
import { creatorEarnings } from '../commission/post.js';

export const creatorEarningsRouter: Router = Router();
creatorEarningsRouter.use(requireCreator);

/**
 * What a creator is owed, on their own magic link.
 *
 * Two rules govern every line of this file.
 *
 * Creators never see customer data. An order becomes a date, a value and a
 * commission — no name, no email, no address, no order id from the brand's
 * system, nothing that could identify the person who bought. That is enforced
 * here, in the serialiser, not by a UI that happens not to render a field.
 *
 * Every figure shows its arithmetic. A creator who cannot see how a number was
 * reached has no way to challenge it, and the whole point of Anton is that
 * these numbers survive being challenged.
 */

/**
 * The only shape an order is ever allowed to take on this surface.
 *
 * Written as an explicit allow-list rather than by deleting fields from the
 * document: a deny-list silently starts leaking the day someone adds a column
 * to Order, and the column they will add is the customer's email.
 */
interface CreatorVisibleLine {
  readonly id: string;
  readonly type: 'accrual' | 'reversal' | 'adjustment';
  readonly occurredAt: Date;
  readonly orderedAt: Date | null;
  readonly orderValue: { amountMinor: number; currency: string } | null;
  /**
   * The figure the rate was actually applied to.
   *
   * Separate from orderValue on purpose. When a rate is on the subtotal and
   * the order carries shipping, the two differ — and a line showing the total
   * beside "10%" and a number that is not 10% of it is exactly the kind of
   * arithmetic that makes a creator stop trusting the page.
   */
  readonly basisAmount: { amountMinor: number; currency: string };
  readonly amount: { amountMinor: number; currency: string };
  readonly amountFormatted: string;
  readonly ratePercent: number;
  readonly rateBasis: string;
  readonly workings: string | null;
  readonly reason: string | null;
  readonly attributionMethod: string | null;
  readonly attributionConfidence: string | null;
}

/**
 * How the order was credited, in words a creator would use.
 *
 * "code_redemption" means nothing to someone who is not an engineer, and the
 * distinction between a typed code and a click is the thing they are most
 * likely to want to argue with.
 */
function methodLabel(method: string | null): string | null {
  switch (method) {
    case 'code_redemption':
      return 'Your discount code was used at checkout';
    case 'link_last_touch':
      return 'The customer arrived through your link';
    case 'manual_assignment':
      return 'Assigned by the Anton team';
    default:
      return null;
  }
}

creatorEarningsRouter.get(
  '/earnings',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);

    const entries = await CommissionEntryModel.find({ creatorId: creator._id })
      .sort({ createdAt: 1 })
      .lean();

    const [campaigns, attributions] = await Promise.all([
      CampaignModel.find({ _id: { $in: entries.map((e) => e.campaignId) } })
        .select('name brandId currency')
        .lean(),
      AttributionModel.find({ _id: { $in: entries.map((e) => e.attributionId) } })
        .select('_id method confidence')
        .lean(),
    ]);
    const brands = await BrandModel.find({ _id: { $in: campaigns.map((c) => c.brandId) } })
      .select('name')
      .lean();

    /**
     * Orders are loaded for their date and value only.
     *
     * `.select()` is the boundary: the customer fields are never pulled into
     * this process, so they cannot reach the response by accident. rawRow is
     * already select:false and is not requested here either.
     */
    const orders = await OrderModel.find({ _id: { $in: entries.map((e) => e.orderId) } })
      .select('_id orderedAt total status')
      .lean();

    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c]));
    const brandById = new Map(brands.map((b) => [b._id.toString(), b.name]));
    const attributionById = new Map(attributions.map((a) => [a._id.toString(), a]));
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    const payments = await PaymentRecordModel.find({ creatorId: creator._id, voidedAt: null })
      .sort({ paidAt: -1 })
      .lean();

    /* Group by campaign: a creator thinks in campaigns, not in brand ids. */
    const campaignIds = [
      ...new Set([
        ...entries.map((e) => e.campaignId.toString()),
        ...payments.map((p) => p.campaignId.toString()),
      ]),
    ];

    const groups = await Promise.all(
      campaignIds.map(async (campaignId) => {
        const campaign = campaignById.get(campaignId);
        const own = entries.filter((e) => e.campaignId.toString() === campaignId);

        const earnings = await creatorEarnings({
          creatorId: creator._id,
          campaignId: new Types.ObjectId(campaignId),
        });

        const lines: CreatorVisibleLine[] = own.map((e) => {
          const order = orderById.get(e.orderId?.toString() ?? '');
          const attribution = attributionById.get(e.attributionId?.toString() ?? '');
          return {
            id: e._id.toString(),
            type: e.type as CreatorVisibleLine['type'],
            occurredAt: e.createdAt,
            orderedAt: order?.orderedAt ?? null,
            orderValue: order?.total ?? null,
            basisAmount: e.basisAmount,
            amount: e.amount,
            amountFormatted: formatMoney(e.amount),
            ratePercent: percentFromBps(e.rateAppliedBps),
            rateBasis: e.rateBasis === 'order_subtotal' ? 'order subtotal' : 'order total',
            workings: e.workings ?? null,
            reason: e.reason ?? null,
            attributionMethod: methodLabel(attribution?.method ?? null),
            attributionConfidence: attribution?.confidence ?? null,
          };
        });

        return {
          campaignId,
          campaignName: campaign?.name ?? 'Campaign',
          brandName: campaign ? (brandById.get(campaign.brandId.toString()) ?? null) : null,
          earned: earnings.balance.total,
          earnedByCurrency: earnings.balance.byCurrency,
          paid: earnings.paid.total,
          outstanding: earnings.outstanding.total,
          outstandingFormatted: earnings.outstanding.total
            ? formatMoney(earnings.outstanding.total)
            : null,
          unavailableReason:
            earnings.balance.total === null && earnings.balance.byCurrency.length > 1
              ? 'Your orders on this campaign are in more than one currency, so there is no single total.'
              : null,
          orderCount: own.filter((e) => e.type === 'accrual').length,
          reversalCount: own.filter((e) => e.type === 'reversal').length,
          lines,
          payments: payments
            .filter((p) => p.campaignId.toString() === campaignId)
            .map((p) => ({
              amount: p.amount,
              amountFormatted: formatMoney(p.amount),
              paidAt: p.paidAt,
              method: p.method,
              reference: p.reference,
            })),
        };
      }),
    );

    /**
     * Anton never moves money, and the creator is told so here rather than in
     * a footer nobody reads. A figure that looks like a wallet balance and is
     * not one is the single most likely thing to be misunderstood on this page.
     */
    res.json({
      campaigns: groups,
      howThisWorks: {
        whoPays: 'The brand pays you directly. Anton works out what you are owed and shows it to both of you.',
        antonHoldsNothing: 'Anton does not hold your money and cannot send it. There is no balance here to withdraw.',
        whenFiguresChange:
          'If a customer gets a refund, the commission on that order comes back off. You will see it as a separate line, never as a number quietly changing.',
      },
    });
  }),
);

/* ------------------------------------------------------------ tracking */

/**
 * The creator's own codes and links.
 *
 * Their commission rate is on it. A creator who does not know their own rate
 * cannot check anything on the earnings page against anything.
 */
creatorEarningsRouter.get(
  '/tracking',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);

    const assets = await TrackingAssetModel.find({ creatorId: creator._id })
      .sort({ issuedAt: -1 })
      .lean();
    const campaigns = await CampaignModel.find({ _id: { $in: assets.map((a) => a.campaignId) } })
      .select('name')
      .lean();
    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c.name]));

    res.json({
      assets: assets.map((a) => ({
        id: a._id.toString(),
        campaignId: a.campaignId.toString(),
        campaignName: campaignById.get(a.campaignId.toString()) ?? 'Campaign',
        type: a.type,
        value: a.value,
        shortCode: a.shortCode,
        destinationUrl: a.destinationUrl,
        activeFrom: a.activeFrom,
        activeUntil: a.activeUntil,
        status: a.status,
        revokedAt: a.revokedAt,
        commissionRatePercent: percentFromBps(a.commissionRateBps),
        commissionRateBasis:
          a.commissionRateBasis === 'order_subtotal' ? 'order subtotal' : 'order total',
      })),
    });
  }),
);

/* ----------------------------------------------------------- statement */

/**
 * A downloadable statement.
 *
 * Same allow-list as the JSON view, for the same reason: this file gets
 * forwarded to accountants and partners, and a customer's details must not
 * travel with it. Cells are neutralised against formula injection on the way
 * out — a reason field beginning with `=` is a formula the moment this opens
 * in a spreadsheet.
 */
creatorEarningsRouter.get(
  '/earnings/statement.csv',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);

    const entries = await CommissionEntryModel.find({ creatorId: creator._id })
      .sort({ createdAt: 1 })
      .lean();
    const campaigns = await CampaignModel.find({ _id: { $in: entries.map((e) => e.campaignId) } })
      .select('name')
      .lean();
    const orders = await OrderModel.find({ _id: { $in: entries.map((e) => e.orderId) } })
      .select('_id orderedAt total')
      .lean();

    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c.name]));
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    const rows = entries.map((e) => {
      const order = orderById.get(e.orderId?.toString() ?? '');
      return {
        date: (order?.orderedAt ?? e.createdAt).toISOString().slice(0, 10),
        campaign: campaignById.get(e.campaignId.toString()) ?? '',
        type: e.type,
        orderValueMinor: order?.total.amountMinor ?? '',
        ratePercent: percentFromBps(e.rateAppliedBps),
        rateBasis: e.rateBasis,
        currency: e.amount.currency,
        amountMinor: e.amount.amountMinor,
        workings: e.workings ?? '',
        note: e.reason ?? '',
      };
    });

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="anton-statement.csv"');
    res.send(
      toCsv(rows, [
        'date',
        'campaign',
        'type',
        'orderValueMinor',
        'ratePercent',
        'rateBasis',
        'currency',
        'amountMinor',
        'workings',
        'note',
      ]),
    );
  }),
);
