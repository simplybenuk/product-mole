# Mole Rebrand Plan

## Goal

Rebrand the project from **Mole / cascade** to **Mole / mole** while keeping the GitHub repository URL as the stable technical identifier for now.

## Desired outcome

### Public-facing identity
- Product name: **Mole**
- Command surface: **`mole`**
- Chat/Codex prompts: **`/mole-*`**

### Technical/repo reality
- GitHub repository URL may remain unchanged temporarily
- Backward compatibility should exist where reasonable during transition

---

## Why this change

The current name is descriptive but weak on:
- memorability
- mascot energy
- command friendliness
- emotional/brand stickiness

Mole is a better fit because it implies:
- working beneath the surface
- digging through messy signals
- uncovering hidden structure
- connecting buried context
- building useful judgement from what is not immediately visible

---

## Scope of the rebrand

### In scope
- README and docs
- CLI help text
- command vocabulary in docs/examples
- Codex prompt names and prompt contents
- visible UI strings
- plan/docs references where the public identity should now be Mole

### Out of scope for this pass
- changing the GitHub repo URL
- solving package publishing/install naming fully
- perfectly migrating every historical mention if it is purely archival

---

## Migration strategy

### 1. Rebrand public-facing language
Switch user-facing references from:
- Mole → Mole
- mole command → mole command

### 2. Keep compatibility where sensible
- Keep the existing `cli/mole.mjs` file working for now
- Update help/output language toward Mole
- Optionally add a `mole.mjs` launcher later if needed

### 3. Rename Codex prompts
Move from:
- `cascade-*`

to:
- `mole-*`

This aligns the actual user command experience with the new brand.

### 4. Update docs to explain temporary repo naming mismatch
Make it clear that:
- the product is now Mole
- the repository URL/name may still temporarily use `product-mole` or similar until later cleanup

---

## Implementation tasks

### Docs and brand
- [ ] Rename README title and framing to Mole
- [ ] Update key docs from mole branding to Mole branding
- [ ] Add/refresh naming guidance to reflect the decision

### Command surface
- [ ] Update command examples from `mole ...` to `mole ...`
- [ ] Update slash command examples from `/mole-*` to `/mole-*`
- [ ] Update CLI help text to present Mole as the command surface

### Prompt files
- [ ] Rename Codex prompt files to `mole-*`
- [ ] Update prompt bodies to refer to Mole / Mole instance where appropriate
- [ ] Make installer copy the new prompt names

### UI / visible strings
- [ ] Update visible UI strings from Mole / mole to Mole / mole where appropriate

### Compatibility and safety
- [ ] Keep current script path usable during transition
- [ ] Avoid breaking existing working flows more than necessary

---

## Notes

The product should now be thought of as:
- **Mole** — the product/tool/brand
- **mole** — the command surface

The repo URL can be treated as a technical lagging identifier until a later rename is worthwhile.
