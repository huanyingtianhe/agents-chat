# iOS Typography PR and Native Zoom Closure

## Approved Product Decision

The user approved delivering the verified Markdown typography fix without
the experimental automatic scale reset. No Chromium issue will be filed.

Treat the two symptoms separately:

| Symptom | Closure classification | Claim permitted in this PR |
| --- | --- | --- |
| Markdown text inflation on orientation changes | Fixed | Stabilize browser text adjustment across portrait and landscape |
| Unintended native whole-page zoom after pinch-return and rotation in the affected iPhone Chrome | Known compatibility limitation; not fixed in this work | Document the observed limitation, not a complete zoom fix |

End the current native-zoom investigation without pretending that the
symptom has disappeared or that all possible webpage remedies have been
proven impossible. The paired minimal-page evidence establishes that chat/
React/history-recovery code is not necessary for the observed enlargement;
it does not identify the exact native defect.

## Preserved Work and Clean Branch

Keep the existing investigation branch intact. Its remote archives are:

- `archive/markdown-typography-verified-20260919`:
  `79781d534185c75cfc858feda1352de7d7a095c7`.
- `archive/ios-viewport-investigation-20260919`:
  `443d477426a716e813c65284ce67f8163b764de1`.

Prepare a new branch from the latest intended target main, not by deleting
experiments from or rewriting the investigation branch. At design time,
`huanyingtianhe/agents-chat` main is
`7f8c292ec439ce7ac49d976f4b840cebfa534d0e`, the typography milestone's
historical base. This fork's `origin/main` is stale and is not the target
baseline. Recheck the target before preparing or opening the PR.

Extract only the accepted final typography changes, not the full sequence
of experimental commits. Keep research histories and raw diagnostic logs
outside the clean PR. Opening the PR follows completion of implementation
and remote validation, not this design approval alone.

## Production Change

The only application styling change is the document-root policy:

```css
html,
body {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

Integrate the declarations into the existing root rule without replacing
its other styles. Add the verified `.browserslistrc` targets so the CSS
optimizer retains the WebKit prefix:

```text
chrome 111
edge 111
firefox 111
safari 16.4
ios_saf 16.4
```

Preserve the existing desktop targets, normal responsive layout and
ordinary viewport metadata. Do not add minimum/maximum scale constraints,
disable user zoom, force an orientation, modify font-size values or
compensate with CSS zoom/transforms.

No new client hook, state machine, browser detection or event handler is
needed. `app/layout.tsx`, `ChatPageClient`, `ChatShell` and the existing
mobile viewport behavior remain at the target baseline unless a later
target change requires an explicitly reviewed integration.

## PR File Scope

Bring the tested typography parts from `79781d5`:

- `.browserslistrc` and the two declarations in `app/globals.css`.
- `tests/markdown-typography.spec.ts`.
- `tests/helpers/typographyFixture.ts` and
  `tests/helpers/typographyMetrics.ts`.
- The typography project selectors in `tests/playwright.config.ts`.
- `.github/workflows/markdown-typography.yml`, retaining isolated remote
  execution and revision-specific evidence. Adjust its trigger for the
  clean branch/PR rather than retaining a stale investigation-branch-only
  trigger; preserve manual dispatch.

Documentation is limited to this focused closure design and a short
README compatibility note. Do not copy the lengthy investigation plans,
diagnostic upload data, private browser logs or production-only details
into the clean PR.

Do not include diagnostic routes, upload APIs, logging/storage schemas,
native history probes, automatic recovery, preventive recovery, minimal
reproduction scripts, `appViewport` extraction or diagnostic composition
hooks. In particular, neither a default-enabled nor an opt-in automatic
scale reset is part of this PR.

## Compatibility Communication

The README and PR description must distinguish text adjustment from native
page zoom. Explain the affected sequence briefly: pinch larger, return to
original scale, release, then rotate. State that the observed iPhone
Chrome environment can retain unintended native zoom and that this PR
does not correct it.

The paired Safari trial stayed at original scale, so Safari can be
described as the verified temporary alternative for this observed case,
not as a guarantee for every Safari/iOS release. Do not claim a verified
fixed Chrome version, prescribe a downgrade, or promise an upstream fix.

Do not add user-agent branches, warnings, banners or dialogs. Preserve
native pinch accessibility and ordinary navigation. Do not use wording
such as "all iOS rotation/zoom issues fixed" or close the native issue
with a Fixed label. A suitable PR title is "Stabilize iOS Markdown
typography across orientation changes."

## Validation and Acceptance

Reuse the archived red/green evidence for the established policy and run
the final clean revision in GitHub Actions. No local installs, builds,
type checks, tests or browser automation; no subagents.

Require:

- Production builds and type checks on the existing remote workflow.
- Actual HTTP-served CSS containing both root text-adjust declarations;
  source text alone does not prove the optimizer preserved the prefix.
- Existing typography cases across desktop Chromium, Android Chromium and
  iPhone WebKit, including orientation, streaming and the covered Markdown
  surfaces. Preserve existing desktop/mobile regressions.
- Ordinary viewport metadata retaining native zoom without minimum/
  maximum-scale locking. Do not weaken assertions just to hide failures.
- Review of the final diff and built route inventory confirming that none
  of the experimental diagnostic/recovery surfaces are included.
- Record exact clean source, workflow and artifact identities. Do not
  present emulated WebKit success as physical proof of Chrome native zoom.

The user already confirmed the typography fix on the affected iPhone.
The final clean artifact still requires its own remote validation.
Any additional physical smoke check must concern the clean release's
typography, not repeat the concluded browser-zoom experiments.

## Release and Completion

This approval defines PR scope and closure labels; it does not authorize
replacing the currently deployed diagnostic build. Request separate
authorization before deploying a clean release artifact.

Once the clean artifact is authorized and deployed, the experimental
diagnostic pages/APIs are no longer shipped. Keep archive refs and private
historical evidence intact; removing routes is not authorization to delete
stored logs or databases.

The project work can close as "typography fix delivered; native Chrome
zoom limitation documented and accepted." The user's no-reload,
no-visual-compensation and native-pinch requirements remain unchanged.
No external browser issue publication or new scale-reset experiment is
part of this closure.
