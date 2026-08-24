import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../db/connect.js';
import {
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  PostModel,
} from '../db/models/index.js';
import { getStorage } from '../storage/index.js';
import { purgeExpiredData } from './purge.js';

const MONTH = 30 * 86_400_000;

async function makeCreatorWithCampaign(params: {
  name: string;
  campaignEndedMonthsAgo: number;
}): Promise<{ creatorId: Types.ObjectId; key: string }> {
  const creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: params.name,
    handles: [{ platform: 'instagram', handle: params.name.toLowerCase().replace(/\s/g, '.') }],
    status: 'active',
    consent: {
      grantedAt: new Date(Date.now() - params.campaignEndedMonthsAgo * MONTH),
      scopeVersion: '2026-08-v1',
      documentSha256: 'a'.repeat(64),
      ipHash: 'b'.repeat(64),
      method: 'web_form',
      withdrawnAt: null,
    },
  });

  const campaignId = new Types.ObjectId();
  const endDate = new Date(Date.now() - params.campaignEndedMonthsAgo * MONTH);
  await CampaignModel.create({
    _id: campaignId,
    brandId: new Types.ObjectId(),
    name: `Campaign for ${params.name}`,
    status: 'closed',
    platforms: ['instagram'],
    startDate: new Date(endDate.getTime() - 30 * 86_400_000),
    endDate,
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'gifted',
    currency: 'GBP',
    budgetTotal: { amountMinor: 1_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });

  await CampaignCreatorModel.create({ campaignId, creatorId, status: 'reported' });

  const key = `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`;
  await getStorage().writeObject(key, Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg');

  await PostModel.create({
    creatorId,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: endDate,
    metrics: { reach: 5_000, likes: 200 },
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: key,
      sourceImageSha256: 'c'.repeat(64),
      extractedAt: endDate,
      model: 'stub',
      promptVersion: 'extract-v1',
      rawResponse: '{}',
      parseOk: true,
      status: 'verified',
      plausibility: { passed: true, violations: [], skipped: [] },
      fieldConfidence: {},
    },
    verifiedByOperatorId: new Types.ObjectId(),
    verifiedAt: endDate,
    submittedAt: endDate,
  });

  return { creatorId, key };
}

beforeAll(async () => {
  await connectDb();
});
afterAll(async () => {
  await disconnectDb();
});

beforeEach(async () => {
  await Promise.all([
    CreatorModel.deleteMany({}),
    CampaignModel.deleteMany({}),
    CampaignCreatorModel.deleteMany({}),
    PostModel.deleteMany({}),
  ]);
});

describe('retention purge', () => {
  it('leaves data inside the retention window alone', async () => {
    const { creatorId, key } = await makeCreatorWithCampaign({
      name: 'Recent Creator',
      campaignEndedMonthsAgo: 6,
    });

    const result = await purgeExpiredData(false);
    expect(result.creatorsPurged).toBe(0);

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.status).toBe('active');
    expect(await getStorage().objectExists(key)).toBe(true);
  });

  it('purges data past the window, removing objects from storage too', async () => {
    const { creatorId, key } = await makeCreatorWithCampaign({
      name: 'Old Creator',
      campaignEndedMonthsAgo: 30,
    });

    expect(await getStorage().objectExists(key)).toBe(true);

    const result = await purgeExpiredData(false);
    expect(result.creatorsPurged).toBe(1);
    expect(result.postsDeleted).toBe(1);
    expect(result.screenshotsDeleted).toBe(1);
    expect(result.screenshotsFailed).toHaveLength(0);

    // Genuine deletion, not a flag.
    expect(await getStorage().objectExists(key)).toBe(false);
    expect(await PostModel.countDocuments({ creatorId })).toBe(0);
    expect(await CampaignCreatorModel.countDocuments({ creatorId })).toBe(0);

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.status).toBe('removed');
    expect(creator?.handles).toHaveLength(0);
    expect(creator?.email).toBeNull();
  });

  it('keeps the consent tombstone when the data goes', async () => {
    const { creatorId } = await makeCreatorWithCampaign({
      name: 'Tombstone Creator',
      campaignEndedMonthsAgo: 30,
    });
    await purgeExpiredData(false);

    const creator = await CreatorModel.findById(creatorId).lean();
    // The dated note that consent existed outlives the data it covered.
    expect(creator?.consent).not.toBeNull();
    expect(creator?.consent?.grantedAt).toBeInstanceOf(Date);
  });

  it('a dry run reports what would go and deletes nothing', async () => {
    const { creatorId, key } = await makeCreatorWithCampaign({
      name: 'Dry Run Creator',
      campaignEndedMonthsAgo: 30,
    });

    const result = await purgeExpiredData(true);
    expect(result.dryRun).toBe(true);
    expect(result.creatorsPurged).toBe(1);
    expect(result.details[0]?.displayName).toBe('Dry Run Creator');

    // Nothing actually happened.
    expect(await getStorage().objectExists(key)).toBe(true);
    expect(await PostModel.countDocuments({ creatorId })).toBe(1);
    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.status).toBe('active');
  });

  it('anchors on the last campaign end, not on the most recent activity', async () => {
    // A creator whose old campaign ended long ago but who is also on a current
    // one must not be purged.
    const { creatorId } = await makeCreatorWithCampaign({
      name: 'Still Working',
      campaignEndedMonthsAgo: 30,
    });

    const liveCampaignId = new Types.ObjectId();
    await CampaignModel.create({
      _id: liveCampaignId,
      brandId: new Types.ObjectId(),
      name: 'Current campaign',
      status: 'live',
      platforms: ['instagram'],
      startDate: new Date(Date.now() - 10 * 86_400_000),
      endDate: new Date(Date.now() + 20 * 86_400_000),
      deliverableSpec: [{ format: 'reel', count: 1 }],
      compensationModel: 'gifted',
      currency: 'GBP',
      budgetTotal: { amountMinor: 1_000, currency: 'GBP' },
      defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
    });
    await CampaignCreatorModel.create({
      campaignId: liveCampaignId,
      creatorId,
      status: 'accepted',
    });

    const result = await purgeExpiredData(false);
    expect(result.creatorsPurged).toBe(0);

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.status).toBe('active');
  });

  it('purges a creator who was invited long ago and never joined a campaign', async () => {
    const creatorId = new Types.ObjectId();
    await CreatorModel.create({
      _id: creatorId,
      displayName: 'Never Started',
      handles: [{ platform: 'instagram', handle: 'never.started' }],
      status: 'invited',
      joinedAt: new Date(Date.now() - 30 * MONTH),
    });

    const result = await purgeExpiredData(false);
    expect(result.creatorsPurged).toBe(1);

    const creator = await CreatorModel.findById(creatorId).lean();
    // Without this, an invite nobody accepted would be retained forever.
    expect(creator?.status).toBe('removed');
  });
});
