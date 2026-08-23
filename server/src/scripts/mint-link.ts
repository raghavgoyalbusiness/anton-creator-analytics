/**
 * Dev CLI: mint a magic link for a creator.
 *
 *   npx tsx src/scripts/mint-link.ts                    first active creator
 *   npx tsx src/scripts/mint-link.ts --handle amara.bell
 *   npx tsx src/scripts/mint-link.ts --all --campaign <id>
 *
 * The raw token is printed once and only its hash is stored, exactly as the
 * bulk-invite endpoint will behave in step 5.
 */
import { connectDb, disconnectDb } from '../db/connect.js';
import { CampaignModel, CreatorModel, MagicLinkModel, OperatorModel } from '../db/models/index.js';
import { mintToken } from '../lib/tokens.js';
import { loadEnv } from '../config/env.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

await connectDb();
const env = loadEnv();

const operator = await OperatorModel.findOne({ role: 'owner' });
if (!operator) {
  console.error('No operator found. Run `npm run db:seed` first.');
  await disconnectDb();
  process.exit(1);
}

const handle = flag('handle');
const campaignId = flag('campaign');
const all = argv.includes('--all');
const limit = Number(flag('limit') ?? (all ? '10' : '1'));

const query = handle
  ? { 'handles.handle': handle }
  : { status: { $in: ['active', 'invited'] } };

const creators = await CreatorModel.find(query).limit(limit);
if (creators.length === 0) {
  console.error(handle ? `No creator with handle "${handle}".` : 'No creators found.');
  await disconnectDb();
  process.exit(1);
}

const campaign = campaignId
  ? await CampaignModel.findById(campaignId)
  : await CampaignModel.findOne({ status: 'live' });

const webOrigin = env.WEB_ORIGIN;
console.log('');

for (const creator of creators) {
  const { raw, hash } = mintToken();
  await MagicLinkModel.create({
    tokenHash: hash,
    creatorId: creator._id,
    campaignId: campaign?._id ?? null,
    issuedAt: new Date(),
    // The real policy TTL, not a dev convenience: a link that behaves
    // differently in development is a link nobody has actually tested.
    expiresAt: new Date(Date.now() + env.MAGIC_LINK_TTL_MINUTES * 60_000),
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    consentCapturedAt: null,
    firstSubmissionAt: null,
    revokedAt: null,
    issuedByOperatorId: operator._id,
  });

  const handleText = creator.handles[0]?.handle ?? '(no handle)';
  console.log(`${creator.displayName}  @${handleText}  [${creator.status}]`);
  console.log(`  ${webOrigin}/c/${raw}\n`);
}

console.log(`Campaign: ${campaign?.name ?? '(none)'}`);
console.log(`These expire in ${env.MAGIC_LINK_TTL_MINUTES} minutes and work once. Re-run to mint more.\n`);
await disconnectDb();
