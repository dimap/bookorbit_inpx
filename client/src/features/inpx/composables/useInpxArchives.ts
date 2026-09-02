import { ref } from 'vue'
import { Socket } from 'socket.io-client'
import type { InpxArchive, InpxImportCompletedEvent, InpxImportProgressEvent } from '@bookorbit/types'
import { api } from '@/lib/api'
import { createAuthenticatedSocket } from '@/lib/socket'

let socket: Socket | null = null
const progressMap = ref<Map<number, InpxImportProgressEvent>>(new Map())
const subscribedLibraries = new Set<number>()

function getSocket(): Socket {
  if (!socket) {
    socket = createAuthenticatedSocket('/inpx', { autoConnect: true })

    socket.on('inpx:progress', (event: InpxImportProgressEvent) => {
      progressMap.value = new Map(progressMap.value).set(event.archiveId, event)
    })

    socket.on('inpx:completed', (event: InpxImportCompletedEvent) => {
      progressMap.value.delete(event.archiveId)
      progressMap.value = new Map(progressMap.value)
    })

    socket.on('disconnect', () => {
      progressMap.value = new Map()
    })

    socket.on('connect', () => {
      for (const id of subscribedLibraries) {
        socket!.emit('subscribe:library', id)
      }
    })
  }
  return socket
}

export function useInpxArchives(libraryId: number) {
  const archives = ref<InpxArchive[]>([])
  const loading = ref(false)
  const failed = ref(false)
  const busy = ref<Map<number, boolean>>(new Map())

  function subscribe(): void {
    if (subscribedLibraries.has(libraryId)) return
    subscribedLibraries.add(libraryId)
    getSocket().emit('subscribe:library', libraryId)
  }

  async function load(): Promise<void> {
    loading.value = true
    failed.value = false
    try {
      const res = await api(`/api/v1/inpx/libraries/${libraryId}/archives`)
      if (!res.ok) throw new Error('Failed to load INPX archives')
      archives.value = (await res.json()) as InpxArchive[]
    } catch {
      failed.value = true
    } finally {
      loading.value = false
    }
  }

  async function register(name: string, path: string): Promise<boolean> {
    try {
      const res = await api(`/api/v1/inpx/libraries/${libraryId}/archives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
      })
      if (!res.ok) throw new Error(await extractError(res))
      const archive = (await res.json()) as InpxArchive
      archives.value = [...archives.value, archive]
      return true
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to register INPX archive')
    }
  }

  async function startImport(archiveId: number): Promise<void> {
    setBusy(archiveId, true)
    try {
      const res = await api(`/api/v1/inpx/archives/${archiveId}/import`, { method: 'POST' })
      if (!res.ok) throw new Error(await extractError(res))
      const archive = (await res.json()) as InpxArchive
      patchArchive(archive)
    } finally {
      setBusy(archiveId, false)
    }
  }

  async function remove(archiveId: number): Promise<void> {
    setBusy(archiveId, true)
    try {
      const res = await api(`/api/v1/inpx/archives/${archiveId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await extractError(res))
      archives.value = archives.value.filter((archive) => archive.id !== archiveId)
    } finally {
      setBusy(archiveId, false)
    }
  }

  function setBusy(archiveId: number, value: boolean): void {
    busy.value = new Map(busy.value).set(archiveId, value)
  }

  function patchArchive(updated: InpxArchive): void {
    archives.value = archives.value.map((archive) => (archive.id === updated.id ? updated : archive))
  }

  function isBusy(archiveId: number): boolean {
    return busy.value.get(archiveId) ?? false
  }

  function getProgress(archiveId: number): InpxImportProgressEvent | undefined {
    return progressMap.value.get(archiveId)
  }

  function isImporting(archiveId: number): boolean {
    return progressMap.value.get(archiveId)?.status === 'importing'
  }

  return { archives, loading, failed, load, register, startImport, remove, subscribe, isBusy, getProgress, isImporting }
}

async function extractError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] }
    if (Array.isArray(body.message)) return body.message[0] ?? 'Request failed'
    return body.message ?? 'Request failed'
  } catch {
    return 'Request failed'
  }
}
