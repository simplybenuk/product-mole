# Template Update Guide (Upstream → Local Instance)

Use this when you have a local working cascade repo and want to pull structural/template updates safely.

## Recommended model

- **Upstream template repo:** `product-context-cascade`
- **Your working repo:** your private instance with real context

## One-time setup (in your working repo)

```bash
git remote add upstream git@github.com:simplybenuk/product-context-cascade.git
git fetch upstream
```

## Pull latest template changes

```bash
git checkout main
git fetch upstream
git merge upstream/main
# resolve conflicts if needed
git push origin main
```

## Safer release-based update

```bash
git fetch upstream --tags
git merge v0.1   # or newer tags when available
```

## Conflict guidance

- Prefer keeping your real content in `4-context/`, `5-evidence/`, `6-raw/`.
- Review template changes carefully in `0-bootstrap/`, `1-routing/`, `templates/`, `docs/`.
- If both changed same file, preserve your domain truth and manually reapply template structure improvements.

## Branch + PR policy (template repo)

- No direct pushes to `main`.
- Create feature branch for every change.
- Open PR, review, merge.
- Tag releases for stable update points (`v0.1`, `v0.2`, ...).
