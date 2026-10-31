import i18n from '../../i18n'
import { useStore } from '../../store'
import { showToast } from '../kit'
import { MOD } from '../shell/platform'

/**
 * The toast that follows every note delete (right-click, eraser sweep, Delete key, the
 * selection card): "3 notes deleted · Undo". Undo pops the delete's single history entry.
 */
export function notifyNotesDeleted(count: number): void {
  if (count <= 0) return
  showToast({
    message: i18n.t('editor:deleted', { count }),
    action: { label: i18n.t('editor:undo'), hint: `${MOD}Z`, onAction: () => useStore.getState().undoEdit() },
  })
}
