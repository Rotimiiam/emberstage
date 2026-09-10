# Emberstage visual system

## Principles

1. **Calm under pressure.** Primary actions are obvious, status is readable at a glance, and selection never looks live by accident.
2. **Local first, claims second.** Local Core works without an account. Product authentication may use email/password or configured Google OAuth. Provider OAuth is a separate Streaming Setup flow. Stripe and providers are configuration-gated.
3. **One layer, then content.** Prefer a page surface plus separators over nested cards. Use elevation only for dialogs, sticky controls, and genuinely distinct previews.
4. **Action stays near state.** In OBS docks, the selected cue and Take/Show action remain pinned. In short docks, the primary action is above the fold. Portrait layouts prioritize search, selection, and action; optional previews are removed rather than stacked below the workflow.
5. **Accessible restraint.** Keyboard focus is visible, color is never the only state signal, motion is subtle, and reduced-motion preferences are honored.

## Tokens

The implementation uses native system fonts and no network font dependency.

| Role | Local docks | Site / portal |
| --- | --- | --- |
| Canvas | `#15171b` | `#0b0d12`–`#13161b` |
| Surface | `#1e2127` | translucent `#191d26` |
| Raised | `#282c34` | translucent `#212734` |
| Border | `#363b45` | warm white at 16–18% |
| Primary text | `#f4f1e9` | `#f3f4f6` / `#f3efe6` |
| Secondary text | `#aaaeb8` | `#b8bec8` / `#b8b2a5` |
| Accent | `#e8b45c` | `#e6b15a` / `#e1af54` |
| Success | `#8fd0ad` | `#88c5a5` |
| Danger | `#f49a94` | `#dc6f76` |

- **UI type:** Segoe UI / Inter / system sans, 12–16px depending on surface.
- **Display type:** Georgia / Iowan Old Style on marketing and portal headings only.
- **Spacing:** 4px base; common steps are 4, 8, 12, 16, 24, 32px.
- **Radii:** 5–8px in dense OBS docks; 12–20px on site and portal surfaces; pill radius only for chips and compact navigation.
- **Focus:** 2–3px amber ring with clear offset.
- **Motion:** 100–180ms state transitions. Reduced-motion preferences disable animation.

## Responsive specification

### OBS docks

- **698 × 238:** header and toolbar compress; the work area absorbs remaining height; selected cue and primary action stay pinned in view.
- **390 × 720:** preview chrome is intentionally omitted. Search, cue list, selection state, and action remain in that order. Controls do not simply stack into a long page.
- No document-level horizontal scrolling. Internal lists may scroll vertically.

### Landing and portal

- **1440 desktop:** content is capped around 1240–1280px; split layouts are used only when both columns have enough room.
- **390 mobile:** one content column, compact header, full-width primary actions, no decorative product mockup before core copy. Dashboard identity and actions stack while status stays beside its section where possible.
- Horizontal tab groups may scroll themselves; the document must not overflow horizontally.

## Components

### Buttons

- Primary: amber fill, dark text, one per decision group.
- Secondary: quiet surface and visible border.
- Danger: reserved for destructive actions.
- Disabled: reduced contrast, no lift, non-interactive cursor.
- Busy: action label changes to a present-progress phrase such as “Signing in…”.

### Status and badges

- Always include text: `On Program`, `Off Program`, `Connected`, `Disconnected`, `Configuration-gated`, or `Unavailable`.
- Green communicates connected/success; amber communicates pending/configuration; red communicates error/unavailable.
- “Selected” uses amber emphasis and an inset marker. It must not resemble `On Program`.

### Fields and lists

- Labels remain visible; placeholders are examples, not labels.
- Empty states state the next useful action.
- Loading states name what is being checked.
- Errors use a dedicated alert surface and concise recovery copy.
- Lists use separators rather than one card per row.

### Surface-specific behavior

- **Control panel:** Text, Scripture, Songs, and Style share one top-level tab system and pinned output state.
- **Media / Cameras:** source selection is private; Take is explicit. Portrait removes the optional snapshot to keep the source list and action primary.
- **Setup:** numbered sections support scanning, but controls remain native and compact.
- **Browser source:** typography is high-contrast and broadcast-safe, with title/reference subordinate to main copy.
- **Portal:** product authentication and provider OAuth are explicitly separate. Billing/provider controls reflect server configuration rather than implying universal availability.

## State specification

| State | Required treatment |
| --- | --- |
| Empty | Short title plus next action or explanation |
| Loading | Named operation, progress indicator or busy label, blocked duplicate action |
| Error | Red-tinted alert, concise recovery text, optional details |
| Selected | Amber wash + border/inset marker + semantic pressed/selected attribute |
| Disabled | Lower contrast, no hover/lift, preserved readable label |
| Connected | Green status plus explicit `Connected` text |
| On Program | Explicit status label distinct from selected cue |
| Configuration-gated | Amber neutral notice; never present as connected or universally available |

## Screenshot acceptance matrix

Screenshots are saved outside the repository in a newly created temporary proof directory.

| Surface | Viewport | Required acceptance state |
| --- | --- | --- |
| Control panel · Text | 698 × 238 | editor, output status, Take above fold |
| Control panel · Scripture | 698 × 238 | search, empty/results region, navigation |
| Control panel · Songs | 390 × 720 | library empty/selected workflow, primary controls prioritized |
| Control panel · Style | 390 × 720 | section tabs and settings without horizontal overflow |
| Media dock | 698 × 238 | populated demo selection + pinned action |
| Media dock | 390 × 720 | portrait source-first workflow; preview omitted |
| Camera dock | 698 × 238 | populated demo selection + Take camera |
| Camera dock | 390 × 720 | portrait source-first workflow |
| Media setup | 390 × 720 | connect/review/add-docks scan order |
| Browser source | 1920 × 1080 | live text and reference; transparent output |
| Landing | 1440 × 900 | hero, workflow proposition, no overflow/errors |
| Landing | 390 × 844 | compact navigation and honest core/account copy |
| Portal login | 1440 × 900 and 390 × 844 | email/password, optional OAuth only when configured |
| Portal dashboard | 1440 × 900 and 390 × 844 | plan, limits, pairing, provider states, configuration notices |

For every matrix entry: inspect console errors, page errors, and compare `scrollWidth` with `innerWidth`. Exercise interactive selected, empty, loading, error, and disabled states where supported.
