# Freehold interface direction

Freehold should read like a precise account register maintained by an institution: quiet, legible, and accountable. The visual system uses deep charcoal (`#141715`), warm paper (`#e6e8df`), and one low-saturation sage accent (`#b4bfa5`). Rules separate working areas and records; they do not decorate them. Rows carry account information instead of floating cards. Space is reserved for hierarchy: a tight transaction register, a measured page header, and more room only around the account figures that need it.

## Type

**Public Sans** is the interface face. Its clear, even forms keep compact controls and longer explanations readable without the generic feel of an unchosen system font. **IBM Plex Mono** is used for amounts, currency codes, timestamps, request keys, references, and state labels. Its fixed-width digits make ledger figures easy to compare and make identifiers visually distinct from prose. Both are self-hosted from Fontsource, so rendering does not depend on a font service or network access.

## Layout and interaction

The persistent rail anchors navigation on wide screens and becomes a compact horizontal register on narrow screens. Thin dividers establish sections. Available and reserved balances stay separate, including on mobile. Currency accounts remain rows, and no aggregate is calculated across currencies. The interface states when the API snapshot was read and labels balances as ledger projections.

Focus is shown with a restrained inset sage rule. Hover states change only color or border. There are no celebratory animations; reduced-motion settings remove transitions. Status is carried by words and references, never by a decorative success symbol.

## Designed states

- Session reading, expired session, and unavailable session are distinct.
- Account reads show a deliberate reading state, an empty-ledger state, or the API error code. Stale data is labeled as stale.
- History has separate reading, empty, unavailable, and cursor-pagination states.
- Transfer drafts show minor units, the exact request key, and a display-only amount preview. After submission, the payload and key remain visible; an unknown outcome can only retry the same request. Rejections show the API status, exact code, and exact message returned by the API.
- Admin controls show when recent second-factor verification has expired. The API remains the authority for role and recency checks.

## Client boundary

The client formats integer strings using currency precision from `/v1/currencies`; it never calculates a balance, decides whether a transfer is eligible, or reports success before the API returns it. The Next route handler is a fixed-destination, allowlisted HTTP proxy. It forwards session and CSRF/idempotency headers and preserves upstream status, response body, and cookies. It has no database or Redis credentials.

Account and newest-history reads poll every 15 seconds while visible because the API does not currently expose an authenticated event stream. Polling pauses while a user reads older cursor pages. Only nonsecret transfer details are held in tab-local session storage so an uncertain outcome can be retried with the same key.
