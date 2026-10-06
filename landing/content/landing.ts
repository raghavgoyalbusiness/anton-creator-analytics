/**
 * Every word, price and step on the landing page.
 *
 * Components read from here and hold no copy of their own, so the page can be
 * rewritten without touching a component.
 *
 * PLACEHOLDERS — everything below marked `placeholder` must be replaced before
 * this page is public:
 *   - the brand names in `logos` are invented wordmarks, not customers;
 *   - every figure in `howItWorks` mockups and `showcase` is illustrative;
 *   - the prices in `pricing` are proposals, not decided prices.
 * A "trusted by" strip of invented names is fine on a draft and misleading on a
 * live page, so `logos.placeholder` exists to make that impossible to miss.
 */

export type Interval = 'monthly' | 'annual';
export type PlanId = 'starter' | 'growth' | 'scale';

export interface Media {
  /** 9:16 clip in /public/media. Swap the file, keep the name. */
  readonly video: string;
  /** First frame, shown before the clip loads and when motion is reduced. */
  readonly poster: string;
  readonly alt: string;
}

const clip = (n: number, alt: string): Media => {
  const id = String(n).padStart(2, '0');
  return { video: `/media/clip-${id}.mp4`, poster: `/media/clip-${id}-poster.webp`, alt };
};

export const site = {
  name: 'Anton AI',
  wordmark: 'Anton',
  tagline: 'The marketplace for creators and the brands they sell for.',
};

export const nav = {
  links: [
    { label: 'How it works', href: '#how-it-works' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'Sign in', href: '/sign-in' },
  ],
  cta: 'Get started',
};

export const hero = {
  /** Two lines. The second is set in italic. */
  headline: ['Creators your customers trust,', 'measured to the last order.'],
  subhead:
    'Paste your website. We match you with small creators who fit, run the campaign, and show you which posts sold.',
  input: {
    prefix: 'www.',
    placeholder: 'yourbrand.com',
    button: 'Get started',
    label: 'Your website or App Store link',
    errorEmpty: 'Add your website to start.',
    errorInvalid: 'That does not look like a website. Try yourbrand.com.',
  },
  noWebsite: { label: 'No website yet? Tell us about it', href: '/onboarding?describe=1' },
  /** Background wall. Twelve clips, reused across columns. */
  wall: [
    clip(1, 'Creator unboxing a skincare product'),
    clip(2, 'Morning routine clip'),
    clip(3, 'Product close-up in natural light'),
    clip(4, 'Creator talking to camera'),
    clip(5, 'Before and after comparison'),
    clip(6, 'Get ready with me'),
    clip(7, 'Kitchen counter product demo'),
    clip(8, 'Gym bag essentials'),
    clip(9, 'Desk setup tour'),
    clip(10, 'Outfit of the day'),
    clip(11, 'Three ways to use it'),
    clip(12, 'Honest first impressions'),
  ] satisfies Media[],
};

export const logos = {
  /** Invented names. Replace with real customers, with permission, before launch. */
  placeholder: true,
  eyebrow: 'Trusted by teams at',
  names: [
    'Kelp & Co',
    'Fernwick',
    'Northfold',
    'Ostrava Goods',
    'Brightmoss',
    'Quillon',
    'Tamsin Bay',
    'Wexley & Hart',
  ],
};

/* ------------------------------------------------------------ how it works */

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export const howItWorks = {
  eyebrow: 'How it works',
  headline: ['From your website', 'to what sold.'],
  steps: [
    {
      id: 'profile',
      title: 'Tell us who you are',
      body: 'Paste your website. We read it and draft your brand profile: voice, audience, what you sell.',
    },
    {
      id: 'match',
      title: 'Meet creators who fit',
      body: 'We match you with small creators whose followers already buy in your category.',
    },
    {
      id: 'shortlist',
      title: 'Shortlist in a swipe',
      body: 'Keep the ones you like and pass on the rest. Edit a brief before anyone sees it.',
    },
    {
      id: 'schedule',
      title: 'Run it on a calendar',
      body: 'Posts go out on the days you agree. You see each one the moment it is live.',
    },
    {
      id: 'results',
      title: 'See what sold',
      body: 'Every post ranked by orders, not likes. Every number links back to where it came from.',
    },
  ] satisfies Step[],
};

/** Illustrative data for the mockups. A fictional brand, fictional creators. */
export const demo = {
  placeholder: true,
  brand: {
    url: 'kelpandco.com',
    name: 'Kelp & Co',
    voice: 'Calm, plain-spoken, a little dry. Explains the science, never shouts.',
    audience: 'Women 24–38 with sensitive skin who read ingredient lists.',
    sells: 'Barrier serum, gentle cleanser, SPF',
  },
  creators: [
    { handle: 'amara.bell', niche: 'Skincare', followers: '18k', poster: 2 },
    { handle: 'tom.yilmaz', niche: 'Grooming', followers: '9k', poster: 4 },
    { handle: 'nia.castellan', niche: 'Wellness', followers: '24k', poster: 6 },
    { handle: 'obi.tanaka', niche: 'Routines', followers: '31k', poster: 1 },
    { handle: 'lena.bell', niche: 'Fitness', followers: '12k', poster: 8 },
    { handle: 'saoirse.nair', niche: 'Skincare', followers: '7k', poster: 3 },
    { handle: 'rex.eze', niche: 'Lifestyle', followers: '15k', poster: 10 },
    { handle: 'kit.osei', niche: 'Beauty', followers: '22k', poster: 5 },
    { handle: 'priya.hart', niche: 'Skincare', followers: '11k', poster: 11 },
    { handle: 'joss.quinn', niche: 'Budget picks', followers: '19k', poster: 9 },
    { handle: 'esme.lin', niche: 'Sensitive skin', followers: '8k', poster: 12 },
    { handle: 'dev.crawford', niche: 'Routines', followers: '27k', poster: 7 },
  ],
  /** Day of the month → poster number. */
  schedule: { month: 'October', days: 31, startsOn: 3, posts: { 2: 1, 6: 3, 9: 5, 13: 2, 16: 8, 20: 6, 23: 11, 27: 4, 30: 9 } },
  leaderboard: [
    { hook: '“I stopped using three products and my skin calmed down.”', handle: 'amara.bell', orders: 214, poster: 2 },
    { hook: '“Read the ingredient list with me.”', handle: 'esme.lin', orders: 163, poster: 12 },
    { hook: '“The £18 serum I keep rebuying.”', handle: 'joss.quinn', orders: 121, poster: 9 },
    { hook: '“My 4-minute morning, no filter.”', handle: 'obi.tanaka', orders: 88, poster: 1 },
    { hook: '“What a dermatologist told me to drop.”', handle: 'priya.hart', orders: 54, poster: 11 },
  ],
};

/* ---------------------------------------------------------------- the rest */

export const expansion = {
  eyebrow: 'Grow with it',
  headline: ['Start with one campaign.', 'Grow into a program.'],
  body: 'Most teams begin with a single launch and a handful of creators. When something works, turn it into an always-on program: standing codes, commission tracked to the order, and a monthly statement your creators can check line by line. Same account, nothing to migrate.',
};

export const showcase = {
  eyebrow: 'What it looks like',
  headline: ['Real posts.', 'Real orders behind them.'],
  items: [
    { media: clip(3, 'Product close-up in natural light'), handle: 'amara.bell', label: 'Routine', stat: '214 orders' },
    { media: clip(6, 'Get ready with me'), handle: 'nia.castellan', label: 'Get ready with me', stat: '96 orders' },
    { media: clip(11, 'Three ways to use it'), handle: 'priya.hart', label: 'How to', stat: '54 orders' },
    { media: clip(1, 'Creator unboxing a skincare product'), handle: 'obi.tanaka', label: 'Unboxing', stat: '88 orders' },
    { media: clip(9, 'Desk setup tour'), handle: 'joss.quinn', label: 'Budget pick', stat: '121 orders' },
    { media: clip(12, 'Honest first impressions'), handle: 'esme.lin', label: 'First impressions', stat: '163 orders' },
  ],
};

export interface Tier {
  readonly id: PlanId;
  readonly name: string;
  readonly forWho: string;
  /** Monthly figures in whole dollars. Annual is derived: two months free. */
  readonly introMonthly: number;
  readonly regularMonthly: number;
  readonly metric: { value: string; label: string };
  readonly features: readonly { title: string; detail: string }[];
  readonly recommended?: boolean;
}

export const pricing = {
  placeholder: true,
  eyebrow: 'Pricing',
  headline: ['Pay for the work,', 'not the hype.'],
  annualTag: '2 months free',
  introNote: 'first 3 months',
  reassurance: '$0 today. Cancel anytime.',
  cta: 'Get started',
  tiers: [
    {
      id: 'starter',
      name: 'Starter',
      forWho: 'For brands testing creators for the first time.',
      introMonthly: 49,
      regularMonthly: 79,
      metric: { value: '10', label: 'creators a month' },
      features: [
        { title: 'Brand profile from your site', detail: 'Voice, audience and products, drafted for you.' },
        { title: 'Matched creator shortlist', detail: 'Small creators whose followers buy in your category.' },
        { title: 'Order tracking', detail: 'Codes and links, matched to the orders they drove.' },
      ],
    },
    {
      id: 'growth',
      name: 'Growth',
      forWho: 'For teams running a campaign every month.',
      introMonthly: 149,
      regularMonthly: 249,
      metric: { value: '40', label: 'creators a month' },
      recommended: true,
      features: [
        { title: 'Everything in Starter', detail: 'Plus more creators and more campaigns at once.' },
        { title: 'Commission ledger', detail: 'What each creator is owed, worked out line by line.' },
        { title: 'Content rights and ad codes', detail: 'Creators grant usage on their own link. Nothing assumed.' },
        { title: 'Shareable brand report', detail: 'Revenue first, with every source attached.' },
      ],
    },
    {
      id: 'scale',
      name: 'Scale',
      forWho: 'For teams running several brands or markets.',
      introMonthly: 399,
      regularMonthly: 599,
      metric: { value: 'Unlimited', label: 'creators' },
      features: [
        { title: 'Everything in Growth', detail: 'With no cap on creators or campaigns.' },
        { title: 'Multiple brands', detail: 'One login, separate books, nothing shared between them.' },
        { title: 'Always-on programs', detail: 'Standing codes and monthly creator statements.' },
        { title: 'Priority support', detail: 'A named person who answers the same day.' },
      ],
    },
  ] satisfies Tier[],
};

export const managed = {
  headline: ['Rather we ran it?', 'We can.'],
  body: 'Our team finds the creators, writes the briefs, chases the posts and the rights, and sends you one report at the end. You approve the shortlist and the spend. Everything else is ours.',
  cta: 'Book a call',
  ctaHref: '#book-a-call',
  incentive: 'Your first campaign brief is on us.',
  points: [
    { title: 'Recruiting', detail: 'We source, vet and contract every creator.' },
    { title: 'Briefs and approvals', detail: 'One brief per creator, approved by you before it goes out.' },
    { title: 'Rights and ad codes', detail: 'Usage agreed in writing, codes collected before launch.' },
    { title: 'One report', detail: 'Revenue, reach and what to do next, in a link you can forward.' },
  ],
};

export const finalCta = {
  headline: ['Your next customer', 'already follows someone.'],
  subhead: 'Find out who. It takes two minutes.',
};

export const footer = {
  links: [
    { label: 'How it works', href: '#how-it-works' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'For creators', href: '/creators' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Terms', href: '/terms' },
    { label: 'Contact', href: 'mailto:hello@anton.example' },
  ],
  copyright: `© ${new Date().getFullYear()} Anton`,
};
