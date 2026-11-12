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

Appearance has three independent axes: light/dark theme, a style (`looks` in
`tokens.json`: Quiet is the base, Mono overrides type, radius and neutrals) and a
canvas (paper sheet by default, flat optional). A style is data only, emitted as
`:root[data-look]` overrides; components read tokens and never branch on its name.
Defaults are the absence of the attribute, and `index.html` restores the stored
choice before first paint. Native clients may read the same `looks` table.
Looks reach every surface through tokens: the radius scale (`--radius-xs`..`xl`,
`pill`, `composer`), `--density`, motion durations/eases, shadow roles (including
composer and composer focus), `--sunken`, the user-message set (`--user-pad-*`,
`--user-radius`, `--user-fill`, `--user-ring`, ...) and `--font-prose`, which keeps
reading text proportional when Mono sets a monospace `--font-ui`. Component CSS
must not hardcode radii, font stacks or transition timings.

The interface supports English, Simplified Chinese and Traditional Chinese.
Language selection belongs in settings and is independent of chat language.
Switching it updates existing labels, menus and process/error summaries without
remounting inputs or closing the keyboard. Layouts must accommodate English
labels and locale-formatted values; preserve the same compact hierarchy in all
three languages. Native system prompts use localized resources. User/model
content, custom titles and raw diagnostics retain their original language.

## Conversation

The composer owns draft/editing state independently from the growing transcript.
Stream updates are batched, settled history is memoized, and expensive raw tool
payloads are rendered only on expansion. Editing uses the existing composer and
restores the previous draft on cancel. Starting a new conversation clears that
view without stopping another run.

The Web composer accepts local file drops and pasted clipboard images through
the same attachment upload path as the file picker. A drag highlights only the
composer; text and link drags retain browser behavior. Repeated additions queue
in order, a failed upload does not discard later files, and changing conversations
cancels the old composer's uploads. Normal and mixed clipboard text retains its
native insertion and selection. Attachments never submit a message by themselves.
Folder drops are excluded; users select individual files.

Thinking and tool calls follow a linear process timeline: a header (indicator
plus one rolling label for thinking, the running tool and its subject, waiting,
replying, or the settled summary) above a rail of rows. Interim replies are not
part of a rail while the run works: they render as ordinary assistant prose in
the transcript, and the next thinking or tool calls open a new progress block
below them. Earlier blocks settle into their own finished header. When a
completed turn delivers its final answer, every block and interim reply folds
into one progress block above the answer (the first block keeps its identity and
the rest collapse away); failed, stopped and interrupted turns keep their
public replies visible between their blocks and are never folded.

The process header's running indicator is the "bars" indicator: bars breathe in
place; it is the only place bars appear. Every other loading state has its own
treatment (see Loading states) and nothing rotates a tile, box or outline. Tool rows
carry a family-tinted icon tile whose tint strength is the `tile-tint` token, so a
look can mute it; a running tile keeps its family icon and gains that family's own
motion (`data-motion`, `lib/stepMotion.ts`), plus a light streak that travels around
its outline: only the gradient angle turns, so the tile never rotates and the
ring follows the tile's corner radius; static under reduced motion. A settled header reads "Processed · N tool calls", then a
flat strip of one chip per tool family (four, then "+N"; two, then "+N" at 480px
and narrower) and the duration at the far right. Header and step titles use
`--ink-2`. While running only the newest row stays open (earlier rows fold away);
reasoning streams in a short box that follows new text unless the reader scrolls
away, then settles into a taller scrollable block. Consecutive tool calls of one
family group into a single row with a bounded inner list; every row can always
be expanded or collapsed by hand. Details have bounded scrollable height and
expensive payloads render only while open. Status animation belongs on active
system state (indicator, active label), never on settled prose, and honors
reduced motion.

Failed, stopped and interrupted turns keep their already-public replies visible
alongside their terminal status/error. Only a completed turn with an actual
answer folds its earlier public updates. A turn with no final answer must not
collapse its prose into process details.

Web Markdown uses Streamdown with CJK, math/KaTeX and lazy code highlighting.
Native Markdown uses Enriched Markdown/MD4C and RaTeX. Isolated HTML artifacts
and the authenticated computer viewer can use WebViews; the chat itself does not.

## Web Shell

- The user's own message is a solid filled bubble in every look: the accent
  fill with light text in Quiet, the ink fill with inverted text in Mono.
  Copy/edit tools stay reachable while the pointer crosses from the bubble.
- The sidebar is resizable (drag the 6px edge, arrow keys step 16px, double
  click resets to the default; the width persists locally and the handle is
  hidden in the compact drawer layout). Collapsing never hides it: it ends in a
  narrow icon rail with tooltips. The inner content keeps its fixed width while
  only the outer width animates under clipping, so labels slide and fade out
  without reflow.
- Switching destinations (New chat, Search, Projects, Computer, Scheduled)
  slides one active background between nav rows and fades the main area in with
  a slight rise (about 150ms). The search palette animates its scrim (fade) and
  panel (scale and rise) in and out. Reduced motion removes the movement.
- Loading states: there is no generic spinner. Each context shows what fits it.
  - Running tool tile: keeps its family icon plus a family motion (terminal caret
    blink, search sweep, fetch/browser ring, file lines drawing, image twinkle and
    sheen, computer pointer nudge, memory/schedule/MCP soft pulse, thinking bulb
    glow, group layers bob) and a shared accent wash that breathes.
  - Buttons: keep their icon, disable, switch to the progressive label
    ("Saving...") and show the shared `.btn-progress` line sliding along the bottom
    edge. Only refresh/sync/check icons turn themselves (`.ic-turn`, once a
    second). Send keeps its arrow, which lifts and fades while submitting.
  - Lists, pages, panels and first loads: `.skel` skeleton rows shaped like the
    content. "Load more/earlier" is a text label with three fading dots
    (`.loading-dots`).
  - Computer dock connecting: monitor icon with a scan line and "Connecting...".
  - Sidebar running session: three-dot wave, swapped out for the "..." button on
    hover.
  - Status pills: a pulsing accent dot, or the icon of the thing (download,
    restart) with `.ic-pulse`.
  - Reduced motion makes all of these static (progress line becomes a static bar).
  The AI-control glow around the computer viewport is a status frame, not a
  loading indicator.

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
- Documents use a full-screen page, not a bottom drawer. PDFs render locally
  with native scrolling/zoom and page counts on both platforms. Download private
  bytes before rendering, cancel and clear previews when closed or changed, and
  never pass bearer headers to a renderer or external artifact origin. Text and
  HTML retain isolated previews; unsupported formats keep download/share actions.
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
