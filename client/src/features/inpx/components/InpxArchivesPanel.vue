<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Archive, Loader2, Play, Sparkles, Trash2 } from '@lucide/vue'
import type { InpxArchive, InpxImportProgressEvent } from '@bookorbit/types'
import { Permission } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes } from '@/lib/formatting'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useInpxArchives } from '../composables/useInpxArchives'

const props = defineProps<{ libraryId: number }>()

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission(Permission.LibraryUpload))

const { archives, loading, failed, load, register, startImport, startEnrich, remove, subscribe, isBusy, getProgress, isImporting } = useInpxArchives(
  props.libraryId,
)

onMounted(() => {
  load()
  subscribe()
})

const name = ref('')
const path = ref('')
const registering = ref(false)
const removing = ref<InpxArchive | null>(null)
const canSubmit = computed(() => name.value.trim().length > 0 && path.value.trim().length > 0)

async function submitRegister() {
  if (!canSubmit.value || registering.value) return
  registering.value = true
  try {
    await register(name.value.trim(), path.value.trim())
    name.value = ''
    path.value = ''
    toast.success(t('settings.admin.libraries.inpx.registered'))
  } catch (err) {
    toast.error(t('settings.admin.libraries.inpx.registerFailed'), { description: errMessage(err) })
  } finally {
    registering.value = false
  }
}

async function handleImport(archive: InpxArchive) {
  if (isBusy(archive.id)) return
  try {
    await startImport(archive.id)
  } catch (err) {
    toast.error(t('settings.admin.libraries.inpx.importFailed'), { description: errMessage(err) })
  }
}

async function handleEnrich(archive: InpxArchive) {
  if (isBusy(archive.id)) return
  try {
    await startEnrich(archive.id)
  } catch (err) {
    toast.error(t('settings.admin.libraries.inpx.enrichFailed'), { description: errMessage(err) })
  }
}

function requestRemove(archive: InpxArchive) {
  removing.value = archive
}

function cancelRemove() {
  removing.value = null
}

async function confirmRemove() {
  if (!removing.value) return
  const target = removing.value
  try {
    await remove(target.id)
  } catch (err) {
    toast.error(t('settings.admin.libraries.inpx.removeFailed'), { description: errMessage(err) })
  } finally {
    removing.value = null
  }
}

function statusLabel(status: InpxArchive['status']): string {
  return t(`settings.admin.libraries.inpx.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)
}

function phaseLabel(event: InpxImportProgressEvent | undefined): string {
  if (!event) return ''
  return t(`settings.admin.libraries.inpx.phase${event.phase === 'index' ? 'Index' : 'Enrich'}`)
}

function progressPercent(event: InpxImportProgressEvent | undefined): number {
  if (!event || event.total <= 0) return 0
  return Math.min(100, Math.round((event.processed / event.total) * 100))
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : ''
}
</script>

<template>
  <section class="mt-5">
    <h4 class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Archive :size="12" aria-hidden="true" />
      {{ t('settings.admin.libraries.inpx.title') }}
    </h4>

    <div v-if="loading" class="space-y-1.5" aria-hidden="true">
      <Skeleton v-for="index in 2" :key="index" class="h-16 w-full" />
    </div>

    <p v-else-if="failed" role="alert" class="text-[12.5px] text-destructive">{{ t('settings.admin.libraries.inpx.loadFailed') }}</p>

    <p v-else-if="archives.length === 0" class="py-1 text-[12.5px] text-muted-foreground">
      {{ t('settings.admin.libraries.inpx.empty') }}
      <span class="mt-0.5 block">{{ t('settings.admin.libraries.inpx.emptyHint') }}</span>
    </p>

    <ul v-else class="divide-y divide-border rounded-lg border border-border bg-background/45">
      <li v-for="archive in archives" :key="archive.id" class="px-3.5 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-[13px] font-medium text-foreground">{{ archive.name }}</p>
            <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" dir="ltr" :title="archive.absolutePath">
              {{ archive.absolutePath }}
            </p>
          </div>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              archive.status === 'complete'
                ? 'bg-emerald-500/10 text-emerald-700'
                : archive.status === 'failed'
                  ? 'bg-destructive/10 text-destructive'
                  : archive.status === 'importing'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
            "
          >
            {{ statusLabel(archive.status) }}
          </span>
        </div>

        <div v-if="getProgress(archive.id)" class="mt-2.5">
          <div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span class="flex items-center gap-1.5">
              <Loader2 class="animate-spin" :size="12" aria-hidden="true" />
              {{ phaseLabel(getProgress(archive.id)) }}
            </span>
            <span class="tabular-nums"> {{ getProgress(archive.id)?.processed ?? 0 }} / {{ getProgress(archive.id)?.total ?? 0 }} </span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-300"
              :style="{ width: `${progressPercent(getProgress(archive.id))}%` }"
            />
          </div>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
          <span>{{ t('settings.admin.libraries.inpx.totalBooks', { count: archive.totalBooks }) }}</span>
          <span v-if="archive.importedBooks > 0">{{ t('settings.admin.libraries.inpx.importedBooks', { count: archive.importedBooks }) }}</span>
          <span v-if="archive.enrichedBooks > 0">{{ t('settings.admin.libraries.inpx.enrichedBooks', { count: archive.enrichedBooks }) }}</span>
          <span class="ms-auto">{{ formatBytes(archive.sizeBytes ?? 0) }}</span>
        </div>

        <div v-if="canManage && !isImporting(archive.id)" class="mt-2.5 flex items-center gap-2">
          <Button
            v-if="archive.status !== 'complete' || archive.importedBooks === 0"
            variant="outline"
            size="sm"
            :disabled="isBusy(archive.id)"
            @click="handleImport(archive)"
          >
            <Play :size="13" aria-hidden="true" />
            {{ t('settings.admin.libraries.inpx.import') }}
          </Button>
          <Button v-if="archive.importedBooks > 0" variant="outline" size="sm" :disabled="isBusy(archive.id)" @click="handleEnrich(archive)">
            <Sparkles :size="13" aria-hidden="true" />
            {{ t('settings.admin.libraries.inpx.enrich') }}
          </Button>
          <Button variant="ghost" size="sm" :disabled="isBusy(archive.id)" @click="requestRemove(archive)">
            <Trash2 :size="13" aria-hidden="true" />
            {{ t('settings.admin.libraries.inpx.remove') }}
          </Button>
        </div>
      </li>
    </ul>

    <form v-if="canManage" class="mt-3.5 rounded-lg border border-border bg-background/45 p-3.5" @submit.prevent="submitRegister">
      <p class="mb-2 text-[12px] font-medium text-foreground">{{ t('settings.admin.libraries.inpx.registerTitle') }}</p>
      <div class="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]">
        <Input
          v-model="name"
          type="text"
          :placeholder="t('settings.admin.libraries.inpx.namePlaceholder')"
          :aria-label="t('settings.admin.libraries.inpx.nameLabel')"
        />
        <Input
          v-model="path"
          type="text"
          dir="ltr"
          :placeholder="t('settings.admin.libraries.inpx.pathPlaceholder')"
          :aria-label="t('settings.admin.libraries.inpx.pathLabel')"
        />
        <Button type="submit" :disabled="!canSubmit || registering">
          <Loader2 v-if="registering" class="animate-spin" aria-hidden="true" />
          {{ registering ? t('settings.admin.libraries.inpx.registerBusy') : t('settings.admin.libraries.inpx.register') }}
        </Button>
      </div>
    </form>

    <ConfirmDialog
      :open="removing !== null"
      :title="t('settings.admin.libraries.inpx.removeTitle')"
      :description="t('settings.admin.libraries.inpx.removeDescription')"
      :confirm-label="t('settings.admin.libraries.inpx.remove')"
      :busy="removing !== null && isBusy(removing.id)"
      @confirm="confirmRemove"
      @cancel="cancelRemove"
    />
  </section>
</template>
