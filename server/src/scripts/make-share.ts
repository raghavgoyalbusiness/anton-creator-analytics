/** Dev helper: mint a brand share link for the first live campaign. */
import { connectDb, disconnectDb } from '../db/connect.js';
import { CampaignModel, OperatorModel, ShareLinkModel } from '../db/models/index.js';
import { mintToken } from '../lib/tokens.js';
import { loadEnv } from '../config/env.js';

await connectDb();
const env = loadEnv();
const operator = await OperatorModel.findOne({ role: 'owner' });
const campaign = await CampaignModel.findOne({ status: 'live' });
if (!operator || !campaign) {
  console.error('Run `npm run db:seed` first.');
  await disconnectDb();
  process.exit(1);
}
const { raw, hash } = mintToken();
await ShareLinkModel.create({
  tokenHash: hash,
  campaignId: campaign._id,
  label: `${campaign.name} — report`,
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  showCompensation: false,
  showCreatorHandles: true,
  requireEmailGate: false,
  issuedByOperatorId: operator._id,
});
console.log(`${env.WEB_ORIGIN}/r/${raw}`);
await disconnectDb();
