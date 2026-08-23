/**
 * Drains pending extractions.
 *
 *   npx tsx src/scripts/extract.ts            process up to 20
 *   npx tsx src/scripts/extract.ts --limit 5
 *
 * Needs ANTHROPIC_API_KEY. Refuses to start without it rather than failing
 * per-post: a run that silently processes nothing looks like a run that found
 * nothing to do.
 */
import { connectDb, disconnectDb } from '../db/connect.js';
import { loadEnv } from '../config/env.js';
import { drainPending } from '../extraction/pipeline.js';
import { spendSummary } from '../extraction/spend.js';

const argv = process.argv.slice(2);
const at = argv.indexOf('--limit');
const limit = at >= 0 ? Number(argv[at + 1] ?? '20') : 20;

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env before running extraction.');
  process.exit(1);
}

await connectDb();
console.log(`[extract] draining up to ${limit} pending posts with ${env.ANTHROPIC_MODEL}\n`);

const outcomes = await drainPending(limit);

let accepted = 0;
let review = 0;
let skipped = 0;
let costMinor = 0;

for (const outcome of outcomes) {
  costMinor += outcome.costMinor;
  if (outcome.status === 'auto_accepted') accepted += 1;
  else if (outcome.status === 'needs_review') review += 1;
  else skipped += 1;

  const mark = outcome.status === 'auto_accepted' ? 'OK  ' : outcome.status === 'skipped' ? 'SKIP' : 'HOLD';
  console.log(`${mark} ${outcome.postId}  (${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'})`);
  for (const reason of outcome.reasons) console.log(`       ${reason}`);
}

console.log(
  `\n[extract] ${outcomes.length} processed: ${accepted} auto-accepted, ${review} to review, ${skipped} skipped`,
);
console.log(`[extract] estimated cost this run: ${(costMinor / 100).toFixed(2)} GBP`);

const recent = await spendSummary(7);
if (recent.length > 0) {
  console.log('\n[extract] spend, last 7 days');
  for (const day of recent) {
    console.log(`  ${day.dayKey}  ${(day.totalMinor / 100).toFixed(2)} GBP  (${day.extractions} calls)`);
  }
}

await disconnectDb();
