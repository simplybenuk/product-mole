# Current Goals

## Active Delivery Priorities

1. Make working Mole instances easier to validate and upgrade safely.
2. Keep the command surface small, memorable, and outcome-oriented.
3. Preserve the repository's progressive retrieval model while making common workflows easier to invoke.
4. Improve confidence for new adopters through clearer checks, reports, and example flows.

## Current Focus

The highest priority is the working-instance lifecycle:

- instance metadata
- `doctor` checks
- update detection
- upgrade classification
- conservative upgrade reporting

This is the largest current product gap because generated or customised instances need a credible way to evolve as the source/tool repo changes.

## Secondary Focus

The CLI should continue to establish the long-term vocabulary:

- `mole init`
- `mole doctor`
- `mole check-updates`
- `mole upgrade`
- `mole create ...`
- `mole synthesise ...`
- `mole review ...`

## Quality Bar

- Prefer conservative behaviour over surprising automation.
- Avoid overwriting user-owned content.
- Keep commands understandable from their output alone.
- Use tests for CLI behaviour before implementation.

