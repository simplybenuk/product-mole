# Release 2026.09

Released 2026-09-14 to all workspaces.

## Added

- **CSV export for reports.** Any report can be exported as CSV from the
  report menu. Exports include every column in the current view and respect
  the active filters. Limit: 50,000 rows per export.
- **Onboarding checklist.** New workspaces see a five-step checklist on the
  home screen: invite a teammate, connect a data source, create a report,
  share a report, set a weekly digest.

## Changed

- **Pricing page copy.** The Team plan description now leads with the seat
  price. No price changed.

## Fixed

- Report filters no longer reset when the browser tab is restored.

## Known issues

- CSV exports of reports with merged header cells repeat the header value in
  every merged column.
