import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Label,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
} from "react-aria-components";
import { CloseIcon, TrashIcon } from "./icons";
import { useStore } from "../store";
import { previewNote } from "../audio/preview";
import { deleteNotes, setNotesVelocity } from "../midi/edit";
import { midiToName } from "../midi/noteName";

/**
 * Per-note context menu (right-click on a falling note in edit mode).
 * Hijacks the browser context menu to expose note-level edit affordances
 * — currently a velocity slider that sets the velocity of every selected
 * note. Average velocity is shown on multi-select; adjusting the slider
 * sets all selected notes to the new value.
 *
 * History grouping: a single open-menu session collapses to one undo
 * entry. The pre-edit snapshot is captured on the first onChange and the
 * "session" is reset when the menu closes. Subsequent re-opens start a
 * fresh session.
 */
export function NoteContextMenu({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const { t } = useTranslation("dialogs");
  const ctxMenu = useStore((s) => s.contextMenu);
  const setContextMenu = useStore((s) => s.setContextMenu);
  const selection = useStore((s) => s.selection);
  const song = useStore((s) => s.song);
  const transport = useStore((s) => s.transport);
  const transpose = useStore((s) => s.settings.transpose);
  const pushUndoSnapshot = useStore((s) => s.pushUndoSnapshot);
  const setSongPreview = useStore((s) => s.setSongPreview);
  const applySongEdit = useStore((s) => s.applySongEdit);
  const replaceSelection = useStore((s) => s.replaceSelection);

  const sessionStartedRef = useRef(false);

  // Periodic-preview ticker. While the user is actively dragging the
  // velocity slider we replay the selection every 500 ms so the user
  // hears the loudness changing — a one-shot preview at slider release
  // would land too late to inform the gesture. With multiple notes
  // selected we play every distinct pitch in the selection so the chord
  // / scale being edited is audible as a chord, not just a single note.
  // Dedupe by midi: multiple selected instances of the same pitch
  // would just stack identical voices for no gain.
  const previewIntervalRef = useRef<number | null>(null);
  const firePreview = () => {
    const state = useStore.getState();
    if (!state.song || state.selection.size === 0) return;
    const sel = state.song.notes.filter((n) => state.selection.has(n.id));
    if (sel.length === 0) return;
    const seen = new Set<number>();
    for (const n of sel) {
      const midi = n.midi + state.settings.transpose;
      if (seen.has(midi)) continue;
      seen.add(midi);
      void previewNote(midi, n.velocity, 200);
    }
  };
  const startPreviewLoop = () => {
    if (previewIntervalRef.current !== null) return;
    firePreview(); // immediate cue so the very first slider movement is audible
    previewIntervalRef.current = window.setInterval(firePreview, 500);
  };
  const stopPreviewLoop = () => {
    if (previewIntervalRef.current !== null) {
      window.clearInterval(previewIntervalRef.current);
      previewIntervalRef.current = null;
    }
  };

  // Outside-click + Escape close the menu.
  useEffect(() => {
    if (!ctxMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-note-context-menu]")) return;
      setContextMenu(null);
      sessionStartedRef.current = false;
      stopPreviewLoop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
        sessionStartedRef.current = false;
        stopPreviewLoop();
      }
    };
    // Defer mousedown attach by a tick so the right-click that opens the
    // menu doesn't immediately get caught by the outside-click handler.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onMouseDown);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu, setContextMenu]);

  // Belt-and-braces cleanup: clear the ticker on unmount so a quickly-
  // closed menu can't leak an interval.
  useEffect(() => {
    return () => stopPreviewLoop();
  }, []);

  // Selected notes derived per render — kept inline rather than memoised
  // because both inputs (song / selection) already participate in the
  // store's referential change detection.
  const selectedNotes = useMemo(
    () => (song ? song.notes.filter((n) => selection.has(n.id)) : []),
    [song, selection],
  );

  // Hide gracefully if any precondition for "edit a selected note" no
  // longer holds. Doesn't clear the underlying state — the next valid
  // context (re-open + re-select) will use it again.
  if (
    !ctxMenu ||
    !wrapEl ||
    !song ||
    transport === "playing" ||
    selectedNotes.length === 0
  ) {
    return null;
  }

  const wrapRect = wrapEl.getBoundingClientRect();
  // Clamp the menu's position so it can't slide off the canvas edge or
  // get hidden behind the Inspector when the user right-clicks near the
  // viewport's right / bottom border. Width / height are estimates based
  // on the menu's content (`min-w-[14rem]` plus padding); slightly
  // generous on purpose so the eye sees the menu fully on-screen, not
  // teetering at the edge.
  const MENU_W = 240;
  const MENU_H = 160;
  const PAD = 8;
  const rawLeft = ctxMenu.x - wrapRect.left;
  const rawTop = ctxMenu.y - wrapRect.top;
  const left = Math.max(
    PAD,
    Math.min(rawLeft, wrapRect.width - MENU_W - PAD),
  );
  const top = Math.max(
    PAD,
    Math.min(rawTop, wrapRect.height - MENU_H - PAD),
  );

  const avgVelocity =
    selectedNotes.reduce((s, n) => s + n.velocity, 0) / selectedNotes.length;

  const handleChange = (raw: number | number[]) => {
    const value = typeof raw === "number" ? raw : raw[0];
    if (!song) return;
    if (!sessionStartedRef.current) {
      pushUndoSnapshot(song);
      sessionStartedRef.current = true;
    }
    setSongPreview(setNotesVelocity(song, selection, () => value));
    // Each onChange call (every dragged tick or each click on the
    // track) pings the preview ticker. startPreviewLoop is idempotent
    // so continuous dragging doesn't stack intervals.
    startPreviewLoop();
  };
  const handleChangeEnd = () => {
    // The slider thumb was released — stop pinging until the user grabs
    // it again. Without this the ticker would keep firing at the last
    // velocity until the menu itself closed.
    stopPreviewLoop();
  };

  const closeMenu = () => {
    setContextMenu(null);
    sessionStartedRef.current = false;
    stopPreviewLoop();
  };

  // Mirrors the Delete-key shortcut: deletes the entire current selection
  // (which always includes the right-clicked note since opening the menu
  // selects it) and closes the menu. Goes through applySongEdit so the
  // operation is one undo step. Skips noteDeathFx — same rationale as the
  // Delete key (bulk delete shouldn't spawn overlapping puffs).
  const handleDelete = () => {
    if (!song || selection.size === 0) return;
    const next = deleteNotes(song, selection);
    if (next === song) {
      closeMenu();
      return;
    }
    applySongEdit(next);
    replaceSelection([]);
    closeMenu();
  };

  const deleteLabel =
    selectedNotes.length === 1
      ? t("noteMenu.deleteOne")
      : t("noteMenu.deleteMany", { count: selectedNotes.length });

  return (
    <div
      data-note-context-menu
      className="absolute z-50 min-w-[14rem] rounded-md bg-black/55 p-3 shadow-lg ring-1 ring-white/10 backdrop-blur-md"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {selectedNotes.length === 1
            ? midiToName(selectedNotes[0].midi + transpose)
            : t("noteMenu.notesSelected", { count: selectedNotes.length })}
        </div>
        <button
          type="button"
          aria-label={t("noteMenu.close")}
          onClick={closeMenu}
          className="-mr-1 -mt-1 flex h-5 w-5 items-center justify-center rounded text-neutral-400 outline-none transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <Slider
        value={avgVelocity}
        minValue={0.01}
        maxValue={1}
        step={0.01}
        onChange={handleChange}
        onChangeEnd={handleChangeEnd}
        className="flex flex-col gap-1.5"
      >
        <div className="flex items-center justify-between text-xs select-none">
          <Label className="text-neutral-300">{t("noteMenu.velocity")}</Label>
          <SliderOutput className="text-neutral-200 tabular-nums">
            {Math.round(avgVelocity * 127)}
          </SliderOutput>
        </div>
        <SliderTrack className="relative flex h-4 w-full cursor-pointer items-center">
          {({ state }) => (
            <>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full bg-sky-400"
                  style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                />
              </div>
              <SliderThumb className="top-1/2 h-3 w-3 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none data-[dragging]:scale-125 focus-visible:ring-2 focus-visible:ring-sky-400" />
            </>
          )}
        </SliderTrack>
      </Slider>
      <button
        type="button"
        onClick={handleDelete}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded bg-red-500/10 px-2 py-1.5 text-xs font-medium text-red-400 outline-none transition-colors hover:bg-red-500/20 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-red-400"
      >
        <TrashIcon className="h-3.5 w-3.5" />
        {deleteLabel}
      </button>
    </div>
  );
}

