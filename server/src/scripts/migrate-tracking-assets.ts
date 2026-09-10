/**
 * Migrates the discount codes and tracking links embedded on Campaign into the
 * TrackingAsset collection.
 *
 *   npx tsx src/scripts/migrate-tracking-assets.ts          dry run
 *   npx tsx src/scripts/migrate-tracking-assets.ts --apply
 *
 * The embedded arrays are left in place, untouched. They become a read-only
 * historical record: deleting them in the same change that introduces their
 * replacement leaves no way back if the migration turns out to be wrong, and
 * the brand report still reads them until step 7 moves it over.
 */
import { normaliseTypedCode } from '@anton/shared';
import { connectDb, disconnectDb } from '../db/connect.js';
import { CampaignCreatorModel, CampaignModel, OperatorModel } from '../db/models/index.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';

const apply = process.argv.includes('--apply');
await connectDb();

const operator = await OperatorModel.findOne({ role: 'owner' });
if (!operator) {
  console.error('No operator found; run the seed first.');
  await disconnectDb();
  process.exit(1);
}

/**
 * The rate embedded codes were issued under is unknown — the old model had no
 * commission concept at all. Migrated assets get a zero rate, so they attribute
 * orders without silently accruing money nobody agreed to. An operator sets a
 * real rate by reissuing.
 */
const MIGRATED_RATE_BPS = 0;

const campaigns = await CampaignModel.find({}).lean();

let codesFound = 0;
let linksFound = 0;
let created = 0;
let skippedNoJoin = 0;
let skippedExisting = 0;
let skippedCollision = 0;
const notes: string[] = [];

for (const campaign of campaigns) {
  const joins = await CampaignCreatorModel.find({ campaignId: campaign._id })
    .select('_id creatorId')
    .lean();
  const joinByCreator = new Map(joins.map((j) => [String(j.creatorId), j]));

  for (const code of campaign.discountCodes ?? []) {
    codesFound += 1;
    if (!code.assignedCreatorId) {
      skippedNoJoin += 1;
      notes.push(`campaign-wide code ${code.code} has no creator; not migrated`);
      continue;
    }
    const join = joinByCreator.get(String(code.assignedCreatorId));
    if (!join) {
      skippedNoJoin += 1;
      notes.push(`code ${code.code}: creator is not on the campaign`);
      continue;
    }

    const matchKey = normaliseTypedCode(code.code);
    const clash = await TrackingAssetModel.findOne({
      brandId: campaign.brandId,
      matchKey,
      type: 'discount_code',
    }).lean();
    if (clash) {
      if (String(clash.campaignCreatorId) === String(join._id)) skippedExisting += 1;
      else {
        skippedCollision += 1;
        notes.push(`code ${code.code}: already issued to a DIFFERENT creator; left alone`);
      }
      continue;
    }

    if (apply) {
      await TrackingAssetModel.create({
        campaignCreatorId: join._id,
        campaignId: campaign._id,
        creatorId: code.assignedCreatorId,
        brandId: campaign.brandId,
        type: 'discount_code',
        value: code.code,
        matchKey,
        shortCode: null,
        destinationUrl: null,
        issuedAt: code.issuedAt ?? campaign.startDate,
        activeFrom: code.issuedAt ?? campaign.startDate,
        activeUntil: code.expiresAt ?? campaign.endDate,
        status: 'active',
        commissionRateBps: MIGRATED_RATE_BPS,
        commissionRateBasis: 'order_subtotal',
        issuedByOperatorId: operator._id,
      });
    }
    created += 1;
  }

  for (const link of campaign.trackingLinks ?? []) {
    linksFound += 1;
    if (!link.assignedCreatorId) {
      skippedNoJoin += 1;
      continue;
    }
    const join = joinByCreator.get(String(link.assignedCreatorId));
    if (!join) {
      skippedNoJoin += 1;
      continue;
    }

    const existing = await TrackingAssetModel.findOne({
      campaignCreatorId: join._id,
      type: 'tracked_link',
    }).lean();
    if (existing) {
      skippedExisting += 1;
      continue;
    }

    if (apply) {
      // Old links carry no short code, so one is minted. The original URL is
      // preserved as the destination; the old UTM values are already baked
      // into it and are left exactly as they were.
      const { drawUniqueShortCode } = await import('@anton/shared');
      const { randomInt } = await import('node:crypto');
      const takenDocs = await TrackingAssetModel.find({ shortCode: { $ne: null } })
        .select('shortCode')
        .lean();
      const taken = new Set(takenDocs.map((t) => t.shortCode));
      const shortCode = drawUniqueShortCode({
        randomInt: (max) => randomInt(max),
        isTaken: (c) => taken.has(c),
      });

      await TrackingAssetModel.create({
        campaignCreatorId: join._id,
        campaignId: campaign._id,
        creatorId: link.assignedCreatorId,
        brandId: campaign.brandId,
        type: 'tracked_link',
        value: link.destinationUrl,
        matchKey: shortCode,
        shortCode,
        destinationUrl: link.destinationUrl,
        issuedAt: link.issuedAt ?? campaign.startDate,
        activeFrom: link.issuedAt ?? campaign.startDate,
        activeUntil: campaign.endDate,
        status: 'active',
        commissionRateBps: MIGRATED_RATE_BPS,
        commissionRateBasis: 'order_subtotal',
        issuedByOperatorId: operator._id,
      });
    }
    created += 1;
  }
}

console.log(apply ? '\n[migrate] APPLIED\n' : '\n[migrate] dry run — nothing written\n');
console.log(`  embedded codes found     ${codesFound}`);
console.log(`  embedded links found     ${linksFound}`);
console.log(`  assets ${apply ? 'created' : 'that would be created'}  ${created}`);
console.log(`  skipped, no creator      ${skippedNoJoin}`);
console.log(`  skipped, already migrated ${skippedExisting}`);
console.log(`  skipped, code collision  ${skippedCollision}`);

if (notes.length > 0) {
  console.log('\n  notes:');
  for (const n of notes.slice(0, 30)) console.log(`    ${n}`);
  if (notes.length > 30) console.log(`    …and ${notes.length - 30} more`);
}

console.log(
  `\n  Migrated assets carry a ${MIGRATED_RATE_BPS} bps rate — they attribute orders but accrue nothing.`,
);
console.log('  Set real rates by reissuing. The embedded arrays are left untouched.\n');

await disconnectDb();
