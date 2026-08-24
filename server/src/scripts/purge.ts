/**
 * Retention purge.
 *
 *   npx tsx src/scripts/purge.ts            dry run, reports what WOULD go
 *   npx tsx src/scripts/purge.ts --apply    actually deletes
 *
 * Dry run by default, deliberately: the destructive form should be the one you
 * have to ask for. Intended to run on a schedule (cron//systemd timer) with
 * --apply once the dry-run output has been eyeballed at least once.
 */
import { connectDb, disconnectDb } from '../db/connect.js';
import { loadEnv } from '../config/env.js';
import { purgeExpiredData } from '../retention/purge.js';

const apply = process.argv.includes('--apply');
await connectDb();
const env = loadEnv();

console.log(
  `[purge] retention ${env.RETENTION_MONTHS} months after last campaign end; consent kept ${env.CONSENT_RETENTION_YEARS} years`,
);
console.log(apply ? '[purge] APPLYING — this deletes data\n' : '[purge] dry run\n');

const result = await purgeExpiredData(!apply);

for (const d of result.details) {
  console.log(
    `  ${d.displayName.padEnd(28)} last campaign ended ${d.lastCampaignEndedAt?.toISOString().slice(0, 10) ?? 'unknown'}`,
  );
}

console.log(
  `\n[purge] ${result.creatorsPurged} creators, ${result.postsDeleted} posts, ${result.screenshotsDeleted} screenshots`,
);
console.log(`[purge] ${result.consentRecordsExpired} consent records past their own horizon`);
if (result.screenshotsFailed.length > 0) {
  console.error(`[purge] ${result.screenshotsFailed.length} screenshots FAILED to delete:`);
  for (const key of result.screenshotsFailed) console.error(`  ${key}`);
}
if (!apply && result.creatorsPurged > 0) {
  console.log('\n[purge] nothing was deleted. Re-run with --apply to act on this.');
}

await disconnectDb();
