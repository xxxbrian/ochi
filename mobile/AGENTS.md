# Native Client Rules

- Read root `AGENTS.md` and current `docs/design.md`; keep the Vite Web client.
- Version `ios/` and `android/` source. The Xcode scheme is `Ochi`; both app IDs
  remain `co.bojin.ochi`. Do not clean-prebuild over native changes.
- Build locally. Never store signing keys or credentials in the checkout.
- Reuse Web domain types and token JSON, not DOM/CSS or a speculative UI package.
- iOS uses supported native Liquid Glass/context menus. Android keeps the same
  visual language with RN/Expo Blur, not Material; preserve accessibility and
  older-OS/reduced-transparency fallbacks.
- Keep composer TextInput mounted through editing, menus and rotation. Preserve
  draft bytes, measured heights, selection and focus; no dismiss/refocus tricks.
- Model/effort menus use the non-focusable over-keyboard layer. Invalidate old
  anchors and late measurements when orientation or safe-area edges change.
- Use finite, actual available height with IME visible, not portrait constants.
  Own safe-area padding once; backgrounds remain edge-to-edge. All Modals must
  declare landscape support; Android fields disable fullscreen extract UI.
- iOS long-press actions use native context menus with finite RN content bounds;
  rename uses `Alert.prompt`. Android uses the themed centered counterpart.
- Image previews are full-screen, measured-thumbnail transitions. Drag dismisses
  only at fit scale; zoomed gestures pan. Keep toolbar hit targets within the
  modal's own system-bar safe area.
- Keep native Markdown/math rendering and FlashList history; reserve WebView for
  isolated artifacts, authenticated Computer and existing administrator pages.
- SecureStore owns login tokens. Never put tokens into URLs or forward auth
  headers to external image/artifact origins.
- Scope asynchronous commands and busy state to the selected conversation;
  creating a new chat must not cancel or inherit the previous run's controls.
- Test with `pnpm typecheck` and `pnpm test`. Verify changed native interactions
  on built iOS/Android clients, including keyboard, light/dark and both landscape
  directions; source tests and exports alone are not native acceptance.
