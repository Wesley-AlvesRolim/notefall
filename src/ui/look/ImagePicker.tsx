import { useEffect, useState, type DragEvent } from 'react'
import { Button as AriaButton, FileTrigger } from 'react-aria-components'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { Button, Icon } from '../kit'

/**
 * A user image (note texture, stage background): the picture itself is the control. Empty, it is a
 * well to click or drop an image on; set, it shows the image with its name and Replace / Remove.
 * Long file names truncate inside the panel width.
 */
export function ImagePicker({
  label,
  fileName,
  bytes,
  mime,
  accept,
  onPick,
  onClear,
}: {
  label: string
  fileName: string | null
  bytes: ArrayBuffer | null
  mime: string | null
  accept: readonly string[]
  onPick: (file: File) => void | Promise<void>
  onClear: () => void
}) {
  const { t } = useTranslation('inspector')
  const url = usePreviewUrl(bytes, mime)
  const [dragOver, setDragOver] = useState(false)
  const accepts = (file: File) =>
    accept.some((a) => (a.endsWith('/*') ? file.type.startsWith(a.slice(0, -1)) : file.type === a))

  // Drops land here instead of the app-wide drop zone (which would open the file as a song). The app-wide zone counts
  // the elements a drag has entered; keeping this picker's dragenter from it lets that count reach zero, so its
  // "Drop to open" overlay goes away over the picker (and isn't left on screen after a drop it never sees).
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      setDragOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      const file = e.dataTransfer.files[0]
      setDragOver(false)
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      if (accepts(file)) void onPick(file)
    },
  }
  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file) void onPick(file)
  }

  if (!fileName) {
    return (
      <div {...dropProps}>
        <FileTrigger acceptedFileTypes={[...accept]} onSelect={pick}>
          <AriaButton
            aria-label={`${label}: ${t('image.choose')}`}
            className={clsx(
              'nf-focus nf-press flex h-24 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-field bg-fill-field px-3 outline-none data-[hovered]:bg-fill-selected',
              dragOver && 'shadow-[inset_0_0_0_1.5px_var(--ink)]',
            )}
          >
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <Icon.UploadIcon className="h-4 w-4" />
              {t('image.choose')}
            </span>
            <span className="text-caption text-ink-faint">{t('image.dropHint')}</span>
          </AriaButton>
        </FileTrigger>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-2" {...dropProps}>
      <FileTrigger acceptedFileTypes={[...accept]} onSelect={pick}>
        <AriaButton
          aria-label={`${label}: ${t('image.replace')}`}
          className={clsx(
            'nf-focus group/img relative block h-28 w-full cursor-pointer overflow-hidden rounded-field bg-fill-well outline-none',
            dragOver && 'shadow-[inset_0_0_0_1.5px_var(--ink)]',
          )}
        >
          {url && <img src={url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
          <span className="absolute inset-0 grid place-items-center bg-scrim opacity-0 transition-opacity duration-150 group-data-[hovered]/img:opacity-100">
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <Icon.UploadIcon className="h-4 w-4" />
              {t('image.replace')}
            </span>
          </span>
        </AriaButton>
      </FileTrigger>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-caption text-ink-muted" title={fileName}>
          {fileName}
        </span>
        <Button variant="quiet" size="sm" onPress={onClear} className="flex-none">
          {t('image.remove')}
        </Button>
      </div>
    </div>
  )
}

/** Object URL for the stored image bytes, created and revoked in an effect (never during render). */
function usePreviewUrl(bytes: ArrayBuffer | null, mime: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(new Blob([bytes], { type: mime ?? '' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [bytes, mime])
  return url
}
