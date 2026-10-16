# Design And Interaction

This document describes the maintained interface, not a history of UI reviews.
Detailed implementation constraints live in the client `AGENTS.md` files.

## Shared Language

- Neutral light/dark surfaces, restrained typography, compact information
  density and a clear distinction between canvas, sidebar and raised surfaces.
- Frequent controls stay directly accessible. User-message/history actions use
  context menus rather than permanent action rows or repeated overflow buttons.
- Use purposeful motion for state changes, honor reduced motion/transparency,
  and preserve touch targets even when visual controls are compact.
- Do not show technical explanatory copy or placeholder controls in product UI.

`web/src/design/tokens.json` is the shared token source. `pnpm --dir web tokens`
generates `tokens.css`; do not hand-edit that file. Native components reuse token
values with platform-specific surface treatments, not Web CSS.

## Conversation

The composer owns draft/editing state independently from the growing transcript.
Stream updates are batched, settled history is memoized, and expensive raw tool
payloads are rendered only on expansion. Editing uses the existing composer and
restores the previous draft on cancel. Starting a new conversation clears that
view without stopping another run.

Thinking, interim replies and tool calls follow a linear process timeline.
Consecutive tool activity can be grouped, long reasoning has its own disclosure,
and process details have bounded scrollable height. Interim replies are useful
while running and fold into the completed process once the final answer arrives.
Status animation belongs on active system state, not on settled prose.

Web Markdown uses Streamdown with CJK, math/KaTeX and lazy code highlighting.
Native Markdown uses Enriched Markdown/MD4C and RaTeX. Isolated HTML artifacts
and the authenticated computer viewer can use WebViews; the chat itself does not.

## Native Navigation And Input

iOS and Android share the same visual language; Android is not a separate
Material redesign. Native iOS materials/menus are used where supported; Android
uses React Native/Expo surfaces with accessible opaque fallbacks.

- The moving chat page separates visually from the sidebar in both themes.
  Account/header and bottom controls may stay fixed; navigation and history
  share one scrollable content area.
- First send expands the current conversation in place, not a second pushed
  screen. Sidebar destinations must not reveal an intermediate home frame.
- Settings uses normal nested pages. Session search has an opaque full-screen
  background; keyboard avoidance moves its input/results, not that background.
- Model/reasoning menus preserve the active composer and keyboard. Their full
  dismissal animation completes before the menu unmounts.
- Message/history actions use long press and haptics, with native iOS context
  previews. Rename uses an iOS system prompt or a centered Android dialog.
- Images open a black full-screen viewer animated from the thumbnail. Downward
  dismissal applies at fit scale; zoomed dragging pans instead.
- Landscape uses actual window size and safe areas, bounds overlays to the
  available height and accounts for keyboard, navigation and composer occlusion.

## Assets

Provider artwork remains distinct from the Ochi app icon. The current-model
indicator has no persistent selected background; selection belongs in its menu.
Theme-aware monochrome SVGs inherit the foreground, while explicit brand colors
and raster artwork are preserved.

The original app artwork and provenance are under `assets/branding/`. Background
and launch-logo changes remain deferred; do not substitute a traced/recreated
mark for the supplied image.
