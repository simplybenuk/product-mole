// Generated privacy-owned destinations only. No user-selected path is accepted.
export function privacyEligibleLocations(sourceId) {
  return [`6-raw/inbox/${sourceId}.md`, `6-raw/inbox/archive/${sourceId}.md`];
}
export function generatedPrivacyLocations(sourceId) {
  return [`6-raw/staging/${sourceId}.bin`, `6-raw/quarantine/${sourceId}.bin`, `6-raw/quarantine/${sourceId}.md`, ...privacyEligibleLocations(sourceId)];
}
