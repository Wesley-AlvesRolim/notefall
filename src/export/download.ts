export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Filename is derived from the song name with disallowed filesystem
 * characters stripped (Windows is the strictest target). A timestamped
 * `notefall-` name is used when the song name is empty so an unnamed
 * recording still produces a recognisable filename.
 */
export function defaultExportFileName(songName: string, ext: string): string {
  const base = songName.trim().replace(/\.(mid|midi)$/i, '')
  // Strip Windows-disallowed characters and runs of whitespace. Result is
  // ASCII-safe but still preserves Unicode letters / Japanese characters
  // that are valid filenames on every modern OS.
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
  const fallback = `notefall-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  return `${cleaned || fallback}.${ext}`
}
