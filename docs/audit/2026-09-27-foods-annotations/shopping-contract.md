# Shopping scope contract (A12, A15)

- Existing shopping periods, lines, purchase windows, pantry, preview and accept routes remain the authority. A saved period must be discoverable and reopenable without a fresh preview.
- Planning remains possible with no location, budget or currency. A budget is only a preference while prices are unavailable; no exact bill or budget guarantee is implied.
- Location entry is optional and coarse. Browser location access requires a direct tap. Store results and prices require an existing approved provider with usable credentials; absent that, show no fabricated store or price data.
- Replanning preserves qualifying checked rows, notes, manual entries, pantry and ingredient locks. Edits must use the existing owner-scoped revision APIs and display failure rather than claiming a save.
- This worker changes Shopping components, `lib/shopping*` client/planning code, focused Shopping tests, and this audit folder. Recipe policy/evidence and Avoids fixes belong to other workers. No schema change or database write is planned.

Initial source trace: `ShoppingRoot` fetches only periods overlapping a narrow date window and picks one automatically; `ShoppingControls` hides location behind budget and requires currency plus location when budget is entered. `lib/shopping/aggregate.ts` accepts quotes as input, but no grocery quote or store-search provider is wired into the Shopping routes.
