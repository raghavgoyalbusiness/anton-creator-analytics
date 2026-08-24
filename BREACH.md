# Personal data breach procedure

**You have 72 hours from becoming aware of a breach to notify the ICO.** That
clock starts when you have a reasonable degree of certainty a breach occurred,
not when you finish investigating. A partial report inside 72 hours beats a
complete one at 80.

This document exists so that at the moment it is needed, nobody is working out
who to call.

> **Status: this is a drafted procedure, not a rehearsed one.** The named
> contacts below are placeholders. Fill them in before onboarding the first real
> creator, and do a dry run of section 2 at least once.

---

## 0. Who to contact

| Role | Who | Contact |
| --- | --- | --- |
| Decision maker | Raghav Goyal | *fill in* |
| ICO reporting | ICO breach helpline | 0303 123 1113 / ico.org.uk/report-a-breach |
| Technical response | *fill in* | |
| Legal advice | *fill in — no solicitor is retained yet* | |
| Hosting/infrastructure | *fill in* | |

**Anton is a data controller** for creator data under UK GDPR. Creators based in
India additionally bring the DPDP Act 2023 into scope, which has its own
notification expectations — take advice if any affected creator is in India.

---

## 1. What counts as a breach

Any of these, whether or not data left the building:

- Unauthorised access to the database, object storage, or an operator account
- A share link reaching someone it was not issued to, where it showed creator
  compensation or handles
- Screenshots served to the wrong creator or the wrong brand
- An operator laptop or phone with a live session lost or stolen
- A creator reporting that their Anton link opened someone else's data
- Accidental deletion where no recovery is possible (an availability breach
  counts, not only a confidentiality one)
- A supplier telling you they have been breached

**Not automatically a breach:** a creator sharing their own link, a spot-audit
failure, or a plausibility flag. Those are integrity concerns, not data ones.

---

## 2. First hour

Do these in order. Write down the time you started.

1. **Write down what you know.** Open a file, timestamp it, and record what you
   saw and when. Everything below adds to that file. This becomes the record of
   your decision-making, which you may have to defend.

2. **Stop the bleeding, but do not destroy evidence.**
   - Revoke share links: operator dashboard → the affected link → Revoke.
   - Revoke creator sessions: operator → creator → Revoke links.
   - Revoke operator sessions: delete the affected rows from the `sessions`
     collection, or rotate `TOKEN_SECRET`, which invalidates every session and
     every outstanding magic link at once.
   - Rotate `ANTHROPIC_API_KEY` and S3 credentials if either could be exposed.
   - **Do not delete logs, audit rows, or storage objects.**

3. **Establish scope from the audit trail.** The `audit_log` collection is
   append-only and records every operator read, edit, export, share-link
   creation and view. Export it (`/api/operator/export/audit`) before doing
   anything else that writes to it.

   The questions to answer:
   - Which creators' data was reachable?
   - Was compensation or were handles visible on any affected share link?
   - Were screenshots accessible, and for how long? Read URLs live 60 seconds.
   - Did anyone actually access it — `share_links.views` and `audit_log` will
     usually tell you.

4. **Decide whether it is reportable.** Reportable unless it is unlikely to
   result in a risk to people's rights and freedoms. Creator analytics plus
   handles plus rates is commercially sensitive and identifying. **If in doubt,
   report.** Under-reporting is penalised; over-reporting is not.

---

## 3. Within 72 hours

Report to the ICO with whatever you have. The form asks for:

- What happened and when you became aware
- Categories and approximate number of people affected
- Categories and approximate number of records
- Likely consequences
- Measures taken or proposed
- Your contact details

You may submit in phases. Say explicitly that the investigation is ongoing and
you will follow up.

---

## 4. Telling creators

Required **without undue delay** where the breach is likely to result in a *high*
risk to them. For this system that means, at least: their screenshots or
analytics were accessible to someone unauthorised, or their handle was exposed
alongside their rate.

Tell them directly in the WhatsApp community and by email where you have one.
In plain language:

- What happened, in one sentence
- What data of theirs was involved
- What you have done about it
- What they should do, if anything
- Who to contact

Do not minimise, and do not wait for certainty on every detail before saying
anything. A creator who hears about it from you keeps trusting you; one who
hears about it elsewhere does not.

---

## 5. Afterwards

- Record the outcome in the same file, including what you decided and why —
  even for breaches you concluded were not reportable. You must be able to
  demonstrate the reasoning.
- Fix the cause. Add a test that would have caught it.
- If a supplier caused it, review whether to keep using them.

---

## 6. Reducing the blast radius in advance

Already in place, and worth knowing under pressure:

- Magic links expire in 15 minutes and work once, so a leaked batch is stale
  almost immediately.
- Session cookies are httpOnly; there is no durable credential in the browser.
- Screenshot read URLs expire in 60 seconds and the bucket blocks public access.
- Only hashes of tokens are stored, so a database dump yields no working link.
- Consent records store a salted hash of the IP, never the address.
- Operator accounts require TOTP; sessions are 8 hours; bulk export and bulk
  deletion require a fresh password check.
- Every operator action is in an append-only audit log.

The gap worth closing next: there is no alerting on anomalous operator
behaviour. A compromised operator session would be visible in the audit log
afterwards, but nothing would tell you at the time.
