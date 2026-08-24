# Data terms for brand clients

Clauses to include in every brand agreement before a share link is issued.

> **Status: a drafted starting point, not legal advice.** No solicitor has
> reviewed this. Have one do so before it goes into a signed agreement. It is
> written to be readable rather than to be maximally protective, on the
> reasoning that a clause a brand actually reads is worth more than one they
> skim past.

---

## Why this exists

When Anton issues a brand a report link, that brand receives personal data about
creators: handles, audience niches, follower sizes, per-post performance, and —
if the link is configured to show them — individual rates.

Two exposures follow. A brand that retains that data indefinitely, or uses it to
recruit creators directly, has taken something Anton had no right to give. And
Anton, having handed it over without terms, is exposed for having facilitated it.

---

## 1. Purpose limitation

The brand may use creator data received through Anton **solely** to evaluate the
performance of the campaign it relates to.

Specifically **not** permitted without separate written agreement:

- Contacting creators directly to recruit them for other work
- Adding creators to a database, CRM, mailing list, or roster
- Sharing the report or its contents with any third party, including agencies
  and other brands
- Using creator handles or names in marketing materials
- Combining the data with other datasets to build creator profiles

The anti-recruitment clause is the one that matters commercially. It should be
mirrored by the handle-anonymisation toggle on the share link: for a brand you
do not know well, issue a link showing niche and follower band rather than
handles, and rely on the clause as the backstop rather than the first line.

## 2. Retention

The brand shall delete or irretrievably anonymise all creator data received
through Anton within **90 days** of the campaign end date.

Reports downloaded, screenshotted, or exported by the brand are within scope.
Anton can revoke a share link at any time, but cannot reach into files the brand
has already saved — which is precisely why this clause is needed rather than
relying on link revocation.

The brand shall confirm deletion in writing on request.

## 3. No onward transfer

Creator data shall not be transferred outside the brand's own organisation, and
not outside the UK or EEA without an appropriate transfer mechanism.

## 4. Confidentiality of rates

Where a share link displays creator compensation, those figures are commercially
confidential. They shall not be disclosed to any third party, nor used to set or
benchmark rates in negotiations with creators directly.

## 5. Security

The brand shall protect creator data with measures appropriate to its
sensitivity, and shall not post report links in shared channels, wikis, or
anywhere accessible beyond the individuals who need them.

Report links are personal. The brand shall ask Anton for additional links rather
than forwarding one.

## 6. Breach notification

The brand shall notify Anton **within 24 hours** of becoming aware of any
unauthorised access to or disclosure of creator data received through Anton, and
shall cooperate with Anton's own notification obligations. See BREACH.md.

## 7. Content usage rights are separate

**Receiving a performance report grants no rights over creator content.**

Reposting a creator's video, running it as a paid advertisement, using it on a
website, or using a creator's name or likeness requires a licence granted by
that creator. Anton records these in the `ContentLicense` model, per campaign,
defaulting to no licence granted.

A brand that boosts a creator's post as an ad without a licence is exposed on
copyright and, where the creator is identifiable, on image rights. So is Anton
for having handed over the material without saying so. This clause is the
saying-so.

## 8. Creator deletion requests

Creators can delete their data from Anton at any time. On being notified that a
creator has done so, the brand shall delete that creator's data from its own
records, and shall not use it in any materials produced after that date.

Materials already published are out of scope; this is not a retroactive
obligation on things already in the world.

## 9. Status of the figures

The brand acknowledges that performance figures sourced from creator screenshots
are **creator-reported with a source image attached**, not platform-verified.
Anton reads them from images creators supply, checks them against each creator's
own history, flags implausible values, and spot-audits a random sample.

Anton does not warrant the figures are free from creator misreporting, and makes
no representation that they match what the platform would report. Where figures
are sourced via platform API authorisation, they are labelled platform-verified
in the report and this paragraph does not apply to them.

---

## Operational checklist before issuing a share link

- [ ] Brand agreement signed, including the clauses above
- [ ] Decided whether handles are shown or anonymised to niche plus band
- [ ] Decided whether compensation is shown — default off; showing it forces the
      email gate on automatically
- [ ] Expiry set appropriately; 30 days is the default and rarely needs extending
- [ ] Named recipient known, so a view log entry can be attributed
