# 12 — Design Direction: "Letterhead & Docket" (v3)

Adopted 2026-08-04 after Adam asked for a high-end professional treatment and Jeff called v2 "somewhat generic." This document is the design contract — future UI work follows it.

## Concept

The app is the finest object in a trial lawyer's world: engraved stationery, the morning docket, a dark wood-paneled frame around crisp paper. Modern editorial execution, zero skeuomorphism.

- **The frame:** navigation chrome (rail, mobile tab bar, login backdrop) is dark oxblood-brown (`--frame`), matting a light paper document. Gallery-matting contrast is what reads "premium."
- **Three type voices:**
  - **Marcellus** — engraved smallcaps: wordmark, nav, section labels, buttons. Always letter-spaced, always uppercase.
  - **Libre Caslon Text** — the content voice (Caslon has been the lawyer's typeface for three centuries): event/task titles, the masthead date, notes, PAM's replies, empty states (italic).
  - **Public Sans** — utility chrome only: meta lines, pills, form controls.
- **Brass is metal, not paint:** hairlines (card top edges, double rules), tabular numerals (docket times), active states, the certificate border on login. Never large fills.
- **Oxblood is authority:** solid fills (buttons, active day tab, user chat bubble) via `--oxblood-solid`, which stays DEEP in dark mode — light oxblood on dark drifts pink, the cardinal failure of this palette (`--link` switches to brass in dark for the same reason).
- **Signature details:** the corner-bracket monogram; double-rule "certificate" dividers (`.double-rule`); the Daily Docket masthead on Today; ❧ on the statute drawer; schedule rows with brass tick + hairline spine.
- **Dark mode is the candlelit study** — near-black warm grounds, cream Caslon, brass glow. Not an inversion; both themes hand-tuned.
- **Motion:** one dignified entrance (`settle`, 4px rise) and nothing else. Reduced-motion respected.

## Hard rules carried from Jeff's feedback (docs/10)

16.5px base type minimum, A/A+ zoom toggle, quiet Today (masthead + one day + its tasks), day tabs titled "August 5 calendar," statute reminders visually quarantined with no Move affordance anywhere.

## Tokens

All color goes through custom properties in `src/web/src/styles.css` (`:root` + dark override). Never hard-code a hex in a component. Fonts self-hosted in `src/web/public/fonts/` (latin subsets).

## Review tooling

`e2e/design-shots.ts` captures login + dark-mode screenshots against the E2E server (port 8799, started with keys blanked). E2E suite screenshots cover light mode. Kill strays by port (`fuser -k 8799/tcp`), never `pkill -f` with a pattern that appears in your own command line.
