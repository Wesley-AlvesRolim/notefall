# notefall design system

How notefall's interface looks and behaves, and how to build UI that fits. Read this before adding or changing anything outside the 3D canvas. The code is the source of truth for values; this document says what they are for and the rules for using them.

notefall makes falling-notes piano videos. The picture is the product: falling notes, a lit keyboard, particles. Every rule below exists to keep the interface quiet around that picture while staying clear enough for a long editing session.

**Where things live**

| What | Where |
|---|---|
| Design tokens (CSS variables) | `src/ui/kit/tokens.css` |
| The same tokens as Tailwind names | `tailwind.config.js` (`theme.extend`) |
| Component kit (react-aria + tokens) | `src/ui/kit/` (import from `./kit` / `../kit`) |
| Icons | `src/ui/kit/icons.tsx` (`Icon.*`, `LogoMark`) |
| Screen surfaces (islands, pill, start card, sheets) | `src/ui/shell/` |
| Customize panel and its rows | `src/ui/Inspector.tsx`, `src/ui/controls.tsx`, `src/ui/look/` |
| Strings | `src/i18n/locales/{en,ja}/<namespace>.json` |

---

## Principles

1. **The picture is the product.** The brightest and most colourful thing on screen is always the user's video. The UI has no accent hue: `ink` on glass is the whole palette.
2. **Float, don't frame.** The canvas runs edge to edge. Controls are glass surfaces over it, never panels that box it in.
3. **One way to do a thing.** Each control lives in one place. One button, one slider, one menu, one disclosure — the kit's. Don't restyle them per screen.
4. **Few panels, by task.** Closed, the screen shows two top islands and the transport pill. Panels open only from the Customize and Timeline toggles in the pill.
5. **Touch the thing, not its number.** Where a setting has a visual form (a gradient, a curve, an image, a position), edit that form directly. Sliders are the fallback.
6. **Details carry the quality.** Alignment, type, motion and state changes make it feel premium. Decoration never stands in for them.

---

## Layout

Everything floats over a full-window canvas (the 16:9 video is letterboxed in the middle). Positions come from `GEOMETRY` in `src/ui/kit/Surface.tsx`; use it, not literals.

```
┌ song island ──────────────┐   loading island    ┌ input island ───────────────┐
│ ◆notefall  File  name ●  ↶ ↷│                     │ MIDI input ▾  ● Record ▾ │ Export │
└───────────────────────────┘                     └─────────────────────────────┘
                     canvas (16:9, letterboxed)           ┌ Customize ─┐
                     start card when there is no song      │ tabs  🔍    │
┌ Timeline (floating, optional) ───────────────────┐      │ sections…   │
└──────────────────────────────────────────────────┘      └─────────────┘
           ( ⏮ ⟲ ▶ ⟳  0:20 ──●──── 5:24 │ 1.0× 🔈 ⟳ ⬡ ⛶ │ Customize  Timeline )
```

| Surface | Position | Notes |
|---|---|---|
| Song island | top-left, `EDGE` (16) from the edges, height `BAR` (52) | Wordmark = the app menu (shortcuts, language, report a bug, request a feature, GitHub, analytics switch, build). Then File, the song name (rename inline, 6px dot when unsaved), Undo, Redo. |
| Input island | top-right | MIDI device menu, Record + ▾ (takes list, count-in switch at its top), divider, Export (the one primary button). |
| Transport pill | bottom-centre, `PILL_BOTTOM` (20) from the bottom, height `PILL` (60) | Back to start, −10 s, play (40px white disc), +10 s, time, scrubber, total │ speed, volume, loop, reset camera, fullscreen │ Customize, Timeline. |
| Customize panel | right, top 80 (= 16 + 52 + 12), bottom 92 (= 20 + 60 + 12), width `PANEL` (344) | Opens from the pill. Tabs + search, sections, footer with "Reset to defaults" and close. |
| Timeline | left 16, bottom 92, right 16 (or left of Customize when open) | Floating, never docked full-width. Starts closed; ⌘B or the pill toggles it. |
| Selection card | beside the selected notes, never over them, above the timeline / pill, left of Customize | See [Editing notes](#editing-notes). |
| Toast | centred, just above the pill | One at a time. |
| Loading island | top-centre | "Loading piano sounds" + progress. The app stays usable. |
| Start card | centre of the canvas, when there is no song | Open a file, demo songs, record. Goes away on any press outside it or Esc. |
| Dialogs | centred over `scrim` | Export, confirmations, feedback, shortcut sheet. |

**Behaviour of the chrome**

- While playing, the islands and the pill fade out after 2 s without pointer movement (`src/ui/shell/idle.ts`); any move or tap brings them back. They never fade under an open menu, popover or dialog.
- While the mouse is over the Customize panel the islands and pill step aside (playing or paused), so the picture can be judged while tuning; they come back when the pointer leaves.
- Fullscreen fullscreens the app root, so all chrome comes along.
- Never stack glass on glass. Menus, pickers and dialogs sit beside their trigger, not over another glass surface. Popovers near the bottom keep clear of the pill (`containerPadding`).
- The minimum supported viewport is 1024 px; below it `UnsupportedScreen` is shown. Narrow layouts (phone / tablet) are not designed yet: when they are, the pill stays at the bottom and panels become sheets that slide up from it, with every primary control at `touch-min` (44px) or larger.

---

## Tokens

Use the Tailwind names in components. Raw colour values (`#…`, `rgba(…)`, `neutral-*`, `sky-*`…) don't belong in UI code.

### Colour

| Token | Tailwind | Value | Use |
|---|---|---|---|
| `--canvas` | `bg-canvas` | `#05060a` | Behind everything; letterbox bars. Never a UI surface. |
| `--glass-fill` | `bg-glass` (via `nf-glass`) | `rgba(16,17,20,.58)` | The UI material: islands, panels, the pill. |
| `--glass-fill-strong` | `bg-glass-strong` (via `nf-glass-strong`) | `rgba(16,17,20,.82)` | Surfaces that are read: menus, dialogs, pickers, toasts, tooltips, the selection card. |
| `--glass-fill-solid` | `bg-glass-solid` | `#15161a` | Fallback with no `backdrop-filter` or reduced transparency (automatic). |
| `--glass-edge` | `border-glass-edge`, `bg-glass-edge` | `rgba(255,255,255,.10)` | 1px edge of glass; dividers inside a surface. |
| `--ink` | `text-ink`, `bg-ink` | `#f3f2ee` | Text and icons people act on; primary fill; slider fill and knobs; focus ring. |
| `--ink-muted` | `text-ink-muted` | 66% ink | Labels, secondary text, inactive tabs. |
| `--ink-faint` | `text-ink-faint` | 44% ink | Hints, range ends, shortcut hints only. Never for something the user must read to act. |
| `--on-ink` | `text-on-ink` | `#0e0f11` | Text / icons on an ink fill. |
| `--fill-hover` | `bg-fill-hover` | 7% white | Hover wash. |
| `--fill-selected` | `bg-fill-selected` | 13% white | Pressed toggles, active tab / segment, focused menu row. |
| `--fill-field` | `bg-fill-field` | 7% white | Value fields, selects, segmented controls. |
| `--fill-track` | `bg-fill-track` | 16% white | Unfilled slider / scrubber track. |
| `--fill-well` | `bg-fill-well` | 32% black | Wells that hold a picture (preset chips, image picker). |
| `--record` | `bg-record` | `#ff5a4f` | The record dot. Nothing else. |
| `--danger` | `text-danger` | `#ff8b80` | Text / icon of destructive actions (Delete, Remove audio, Clear recent). Never a fill. |
| `--scrim` | `bg-scrim` | `rgba(5,6,10,.45)` | Behind modal dialogs and the file-drop overlay. |
| `--logo-note` | — | `#5ad7ff` | The falling note in the logo. Brand only, never UI. |

The user's note colours are the only hues on screen. Preset thumbnails, the gradient bar and the colour picker's "In this song" row show them as content.

### Type

One family: **Geist** (`@fontsource-variable/geist`), falling back to Hiragino Sans / Noto Sans JP for Japanese. Numbers use tabular figures (set globally). No monospace, no second display face.

| Tailwind | Size / line / weight | Use |
|---|---|---|
| `text-display` | 18 / 24 / 600 | Dialog and sheet titles. |
| `text-title` | 15 / 20 / 600 | The wordmark. |
| `text-heading` | 13 / 18 / 600 | Section and panel headings. |
| `text-label` | 13 / 18 / 500 | Button and tab labels. |
| `text-body` | 13 / 18 / 400 | The base: labels, values, names, times. |
| `text-caption` | 12 / 16 / 400 | The floor: hints, range ends, preset names. Nothing is smaller. |

The base 13px is set on `body`, not `html`, so `rem` stays 16px and Tailwind's spacing is untouched.

### Spacing, radius, size, shadow

- **Spacing** is Tailwind's 4px scale: `0.5` (2) between tabs / segments, `1` (4) between buttons in an island, `1.5` (6) island padding, `2` (8) label to control, `3` (12) between fields and between stacked surfaces, `4` (16) screen margin and panel inset, `5` (20) pill offset, `6` (24) dialog inset.
- **Radius**: `rounded-round` islands, the pill, buttons, switches, toasts · `rounded-panel` (18) panels, the selection card, dialogs · `rounded-tab` (9) tabs, preset chips · `rounded-field` (8) fields, selects, segments, lanes. Menus use 14.
- **Size**: `h-control-sm` 28 compact controls · `h-control` 36 text buttons · `h-icon-btn` 40 icon buttons · `h-play` 40 play · `h-bar` 52 top islands · `h-pill` 60 the pill · `w-panel` 344 Customize · `w-card` 252 the selection card · `touch-min` 44.
- **Shadow**: `shadow-glass` (built into `nf-glass`), `shadow-knob` for slider knobs and gradient stops.

### Glass

One material, applied with the class `nf-glass` (or `nf-glass-strong`): fill + `backdrop-filter: blur(36px) saturate(1.5)` + 1px edge + `shadow-glass`. It falls back to the solid fill automatically. `backdrop-filter` re-blurs the WebGL canvas every frame, so keep the number of glass surfaces on screen small and measure frame time when adding one.

---

## Motion

Crisp and short. Things that open come in from where they were triggered with a strong ease-out and leave faster than they came. Classes live in `tokens.css`; they use the individual `scale` / `translate` CSS properties so they combine with Tailwind's transform utilities.

| Class / helper | What |
|---|---|
| `nf-press` | Press feedback (scale 0.97, 160 ms). Every kit button has it. |
| `nf-pop` | Popovers, menus, selects: grow from the trigger (`--trigger-anchor-point`), 170 ms in / 110 ms out. Built into the kit `Popover`. |
| `nf-tip` | Tooltips, 125 ms. Built into `Tooltip`. |
| `nf-modal`, `nf-scrim-anim` | Dialogs stay centred and scale in; the scrim fades. Built into `Dialog`. |
| `nf-enter-right`, `nf-enter-up`, `nf-enter-fade` + `nf-leaving` with `usePresence(open)` | Enter / exit of panels, toasts, cards. `usePresence` keeps the element mounted while it fades out. |
| Easing tokens | `--ease-out` `cubic-bezier(.23,1,.32,1)`, `--ease-in-out`, `--ease-drawer`. |

Rules: UI animation stays under 300 ms; never animate something triggered from the keyboard many times a day; selected-state backgrounds slide between options (tabs, segmented controls) rather than jump; `prefers-reduced-motion` keeps fades and drops movement.

---

## Interaction

- **Focus ring**: 2px `ink`, offset 2px, via the class `nf-focus`. On react-aria controls it shows only for keyboard focus (`data-focus-visible`). A control pressed with the mouse doesn't keep focus (`useReleaseFocusAfterPointer`, mounted in `Layout`), so the next key goes to the app's shortcuts and the PC-keyboard piano and no ring appears. Text fields, sliders, menus and dialogs keep their focus.
- **States**: hover `fill-hover`; pressed / open `fill-selected` (`aria-pressed`, `aria-expanded`, `data-selected`); disabled 40% opacity.
- **Shortcuts**: global ones live in `src/ui/useGlobalShortcuts.ts` and are listed in the shortcut sheet (`?`). Letter keys play notes on the PC-keyboard piano, so don't add letter shortcuts. Inputs stop propagation so typing never triggers shortcuts.
- **Mouse on notes** follows FL Studio's piano roll and does not change: click selects and drags, double-click selects, right-click deletes, right-drag erases, ⌥-click splits, ⌘-click adds to the selection, ⌘-drag selects a range, drag an edge to resize, wheel scrubs time. There is no note context menu.

---

## Components

All interactive pieces are react-aria components styled with the tokens. Import from the kit; extend the kit (small, additive) rather than styling a one-off.

### Kit (`src/ui/kit`)

| Component | Use |
|---|---|
| `Button` | Text button. `variant`: `quiet` (default), `primary` (one per screen: Export, a dialog's confirm), `field` (a button that sits on a field background), `danger` (destructive rows). `size`: `md` / `sm`. `icon`, `hint` (e.g. a shortcut). |
| `IconButton` | Icon-only. Required `label` (aria-label + tooltip), optional `shortcut`. Only for universal media / window controls: play, skip, volume, close, reset, undo, redo. `size="play"` is the white play disc. |
| `ToggleButton` | Labelled toggle (Customize, Timeline, Follow playhead). Selected = `fill-selected`. |
| `Tooltip`, `Kbd` | Hover / focus label with optional key caps. |
| `Switch` | On/off. |
| `SegmentedControl` | 2–5 short choices side by side. `present` rings values used by part of a mixed selection; `value={null}` selects nothing. |
| `Select` | One of many (long option lists). |
| `Disclosure` | A row that folds content away ("More settings", "Advanced"). |
| `Progress` | Determinate bar. |
| `KnobThumb` | The slider knob for any react-aria `Slider`: centred on the track, grows on hover / drag. Put the track's centre line at `top-1/2`. |
| `Divider` | Rule between groups inside one surface. |
| `Popover`, `Menu`, `MenuPopover`, `MenuItem` (`icon`, `hint`, `danger`, `checked`), `MenuSeparator`, `MenuSection`, `MenuTrigger`, `SubmenuTrigger` | Menus and floating surfaces. Shortcut hints at the right edge in `ink-faint`; destructive rows `danger`. |
| `Dialog`, `DialogText` | Centred modal over the scrim. Actions right-aligned, primary last. `dismissable={false}` for progress and destructive confirms. |
| `Island`, `Panel` | The glass surfaces (`strong` for read surfaces). |
| `showToast`, `ToastHost` | One toast at a time, optional action (with a shortcut `hint`). Callable from non-React code. Hovering holds it. |
| `usePresence` | Mount / unmount with an exit fade. |
| `GEOMETRY` | Screen geometry constants. |
| `Icon.*`, `LogoMark` | Icons and the logo. |

### Customize rows (`src/ui/controls.tsx`, `src/ui/look/`)

A settings tab is a stack of `Section`s (heading, optional feature switch via `enabledKey`, folds with an animated height); everyday rows first, the rest inside `Detail`. Sections are separated by `glass-edge` rules — no cards inside cards, no border around every block.

| Row | Use |
|---|---|
| `BoundSliderRow` / `SliderRow` | Number with a range: label left, editable value right, track below. Double-click the label resets; right-click opens the value menu. |
| `BoundSwitchRow` / `SwitchRow` | Boolean. |
| `SelectRow` | Enum: becomes a `SegmentedControl` when the options are few and short, a `Select` otherwise. |
| `BoundCountRow` | A small count (colours, stops): segments `2 3 4 5` instead of a slider. |
| `BoundColorRow` / `ColorRow` | Hex field + swatch; the picker opens beside the panel with an "In this song" row of colours the current look uses. |
| `GradientStops` | The gradient as a bar with draggable stops (positions are edited only here; the rows below hold the colours). |
| `PresetSwatch` | The look presets as chips showing real shader renders (`src/ui/look/presets/*.jpg`) tinted with the user's colours. Regenerate with `scripts/capture-preset-thumbs.mjs` when a preset changes. |
| `ImagePicker` | A user image (note texture, stage background): the picture is the control — empty it's a drop / click well, set it shows the image, its name and Remove. |
| `KfMark`, `ScopeNote` | Keyframe marks and the "can't change over time" note (added automatically by the rows above when given `scopeKey` / a bound key). |

**Adding a setting**: add the key to `defaultSettings` (`src/store.ts`); if it should change over time, add it to the animatable lists in `src/midi/settingsKeyframes.ts`; add the row with a `Bound*Row` in the right section of `Inspector.tsx`; add the label to `inspector.json` in both languages. The row then gets search, reset, keyframe marks and the right scope note for free.

### Screen pieces (`src/ui/shell/`, `src/ui/`)

`SongIsland`, `InputIsland`, `AppMenu`, `TakesPopover` (rendered by `Toolbar.tsx`, which holds their state), `TransportPill`, `LoadingIsland`, `StartCard`, `ShortcutSheet`, `ScreenFrame` (the full-page fallback screens), `SelectionCard.tsx`, `TimelineEditor.tsx` / `Timeline.tsx`, `ExportSettingsDialog.tsx`, `ExportProgressModal.tsx`, `FeedbackDialog.tsx`, `ConfirmModal.tsx` (`showConfirm` / `showAlert` from `confirm.ts`).

---

## Editing notes

- While paused, selected notes get the **selection card** beside them: velocity (a value and a slider), hand (Left / Right), finger (1–5), and Delete.
- Mixed selections: velocity shows the range ("64–92") and a band on the track; dragging shifts every note by the same amount and keeps their differences, typing sets all. Hand and finger select nothing, ring the values in use and say "Mixed"; choosing one sets every selected note.
- Hand and finger are note data, saved in the project. How they look is set in Customize: Coloring → By hand (left / right / unassigned colours) and Note labels → Show: pitch, finger or both (the finger sits at the keyboard end).
- Deletes don't show a toast; ⌘Z undoes them.

## Keyframes

- Look changes over time are **keyframes**, marked ◆ — the word video editors use. Never call them pins in the UI (the code still says `pin` / `settingsKeyframes` internally).
- While the playhead sits on a keyframe, Customize shows a header ("Keyframe at 1:21", previous / next, a strip of all keyframes) and a ◆ before every setting that can change over time: filled when set at this keyframe, hollow when carried in from the keyframes around it.
- Settings that can't change over time carry one line under the field: "Can't change over time. Applies to the whole song."
- With no keyframe under the playhead, show nothing about keyframes.
- The timeline's "Keyframes" lane holds them as ◆ (the current one filled); "Add keyframe" is the first button in the timeline header.

---

## Content

- Name things the way a pianist or video maker would: "Fall time", "Lowest key", "Keyframe", "Export", "Takes", "Customize".
- Buttons say what happens or what opens: "Export", "Add keyframe", "Discard and open", "Reset to defaults". Never "OK".
- Sentence case everywhere. No uppercase labels, no letter-spacing on small text.
- Label every app-specific action in words. Only universal media and window controls are icon-only, and each has an `aria-label` and a tooltip.
- Show state only when it matters, in concrete words ("Keyframe at 1:21"). No standing status lines.
- No emoji, no exclamation marks. Errors say what failed and what to do next.
- Every string goes through i18n (English is canonical, Japanese is a full translation). Write natural Japanese, not a literal rendering.

## Icons

- 24px grid, 1.6px round stroke, `currentColor`, filled only where a solid reads better (play, pause, keyframe). Shown at 20px in icon buttons, 17px in text buttons, 16px in menus.
- Add icons to the end of `src/ui/kit/icons.tsx` in the same style. Icons for app-specific actions always come with a text label.

---

## What reads as generated (never do these)

- Uppercase labels with wide letter-spacing.
- Monospace for ordinary numbers or labels "to look technical".
- Text under 12px.
- Standing status lines that explain nothing ("Editing: default look").
- An accent hue on UI chrome (blue buttons, coloured toggles). The UI is ink on glass.
- Cards inside cards, a border on every block, accent bars, gradients as decoration.

## Brand assets

- **Logo**: `LogoMark` (`src/ui/kit/icons.tsx`), also `public/favicon.svg`. Three keys in perspective with one falling note in `--logo-note`.
- **Share image**: `public/og-image.png` (1200 × 630) — a real render in a blue gradient colourway, the wordmark and "Load a MIDI, fix the notes, export the video. Free, no sign-up." in the dark area above the keys. Keep share images and promo stills as real renders, never drawn imitations of notes.
- **Fallback screens** (`ScreenFrame`): the same blue render as the backdrop (`src/ui/assets/backdrop-{wide,tall}.jpg`), a glass card over it.
