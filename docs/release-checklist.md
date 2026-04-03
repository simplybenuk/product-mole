# Release Checklist

Use this for lightweight, branch-based releases of Mole.

## Before release

- [ ] Changes are on a feature/docs/fix branch, not direct on `main`
- [ ] README still reflects the current recommended operating model
- [ ] Upgrade implications are documented if structure or workflow changed
- [ ] `CHANGELOG.md` updated
- [ ] `VERSION` updated
- [ ] Any new templates/docs are linked from README where appropriate

## For upgrade-affecting releases

- [ ] `docs/upgrade-and-instance-management.md` updated if the model changed
- [ ] `cascade.instance-template.yaml` updated if instance metadata expectations changed
- [ ] Clear notes added for adopters about:
  - what can be copied directly
  - what needs manual merge
  - what is optional

## Release

- [ ] Merge branch into `main`
- [ ] Create Git tag (`vX.Y.Z`)
- [ ] Push tag
- [ ] If useful, create a GitHub Release with short upgrade notes
