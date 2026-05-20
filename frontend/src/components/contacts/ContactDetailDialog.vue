<template>
  <v-dialog v-model="show" max-width="680" persistent scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <span>{{ isNew ? 'Thêm khách hàng' : 'Chi tiết khách hàng' }}</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" @click="close" />
      </v-card-title>

      <v-divider />

      <v-card-text>
        <v-row dense>
          <!-- Full name -->
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.fullName" label="Họ và tên" :rules="[required]" />
          </v-col>

          <!-- Phone -->
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.phone" label="Số điện thoại" />
          </v-col>

          <!-- Email -->
          <v-col cols="12" sm="6">
            <v-text-field v-model="form.email" label="Email" type="email" />
          </v-col>

          <!-- Source -->
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.source"
              :items="SOURCE_OPTIONS"
              item-title="text"
              item-value="value"
              label="Nguồn"
              clearable
            />
          </v-col>

          <!-- Status -->
          <v-col cols="12" sm="6">
            <v-select
              v-model="form.status"
              :items="STATUS_OPTIONS"
              item-title="text"
              item-value="value"
              label="Trạng thái"
              clearable
            />
          </v-col>

          <!-- Next appointment date -->
          <v-col cols="12" sm="6">
            <v-text-field
              v-model="form.nextAppointmentDate"
              label="Ngày tái khám"
              type="date"
            />
          </v-col>

          <!-- First contact date -->
          <v-col cols="12" sm="6">
            <v-text-field
              v-model="form.firstContactDate"
              label="Ngày tiếp nhận"
              type="date"
            />
          </v-col>

          <!-- Tags — feature 0019: switched from free-text combobox to tag picker -->
          <v-col cols="12" sm="6">
            <TagPicker v-model="form.tagIds" label="Nhãn" />
          </v-col>

          <!-- Notes -->
          <v-col cols="12">
            <v-textarea
              v-model="form.notes"
              label="Ghi chú"
              rows="3"
              auto-grow
            />
          </v-col>

          <!-- Feature 0020: friendship lifecycle, only on existing contacts -->
          <v-col v-if="!isNew && props.contact?.id" cols="12">
            <v-divider class="mb-3" />
            <div class="text-subtitle-2 mb-2">Kết bạn Zalo</div>
            <FriendshipBadge
              :contact-id="props.contact.id"
              :not-on-zalo="notOnZaloMeta"
            />
          </v-col>
        </v-row>
      </v-card-text>

      <v-divider />

      <v-card-actions>
        <v-btn
          v-if="!isNew"
          color="error"
          variant="text"
          :loading="deleting"
          @click="onDelete"
        >
          Xoá
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="close">Huỷ</v-btn>
        <v-btn color="primary" :loading="saving" @click="onSave">Lưu</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import type { Contact } from '@/composables/use-contacts';
import { SOURCE_OPTIONS, STATUS_OPTIONS, useContacts } from '@/composables/use-contacts';
import FriendshipBadge from '@/components/contacts/FriendshipBadge.vue';
import TagPicker from '@/components/tags/TagPicker.vue';
import { useCrmTags } from '@/composables/use-crm-tags';
import { api } from '@/api/index';

const props = defineProps<{
  modelValue: boolean;
  contact: Contact | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [contact: Contact];
  deleted: [id: string];
}>();

const { saving, deleting, createContact, updateContact, deleteContact } = useContacts();

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const isNew = computed(() => !props.contact?.id);

// Feature 0020: surface Contact.metadata.notOnZalo to the friendship badge.
// metadata isn't on the Contact interface yet so we read defensively.
const notOnZaloMeta = computed<{ checkedAt: string; by: string } | null>(() => {
  const meta = (props.contact as unknown as { metadata?: Record<string, unknown> } | null)?.metadata;
  const v = meta?.notOnZalo as { checkedAt?: string; by?: string } | undefined;
  if (v?.checkedAt && v?.by) return { checkedAt: v.checkedAt, by: v.by };
  return null;
});

interface FormState {
  fullName: string;
  phone: string;
  email: string;
  source: string;
  status: string;
  nextAppointmentDate: string;
  firstContactDate: string;
  notes: string;
  /** Feature 0019 — tag IDs replace the old free-text array. */
  tagIds: string[];
}

const form = ref<FormState>(emptyForm());

// Tag cache — ensures the picker has the org's tag list ready. Phase C:
// contact.tags arrives as enriched objects so we read `.id` directly.
const { loadTags } = useCrmTags();

onMounted(() => {
  loadTags();
});

function emptyForm(): FormState {
  return {
    fullName: '',
    phone: '',
    email: '',
    source: '',
    status: '',
    nextAppointmentDate: '',
    firstContactDate: '',
    notes: '',
    tagIds: [],
  };
}

/**
 * Phase C: `contact.tags` arrives as enriched `{id, name, color, emoji}`
 * objects from the ContactTag junction, so we read the id directly.
 */
function tagsToIds(tags: unknown[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string') {
      out.push((t as { id: string }).id);
    }
  }
  return out;
}

watch(() => props.contact, (c) => {
  if (c) {
    form.value = {
      fullName: c.fullName ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      source: c.source ?? '',
      status: c.status ?? '',
      nextAppointmentDate: c.nextAppointment
        ? new Date(c.nextAppointment).toISOString().split('T')[0]
        : '',
      firstContactDate: c.firstContactDate
        ? new Date(c.firstContactDate).toISOString().split('T')[0]
        : '',
      notes: c.notes ?? '',
      tagIds: tagsToIds(c.tags ?? []),
    };
  } else {
    form.value = emptyForm();
  }
}, { immediate: true, deep: true });

function required(v: string) {
  return !!v || 'Bắt buộc';
}

async function onSave() {
  // Save core contact fields first (without tags). Tags are written via the
  // dedicated PUT /contacts/:id/tags endpoint which knows about the new
  // tagIds shape + does the dual-write.
  const payload: Partial<Contact> = {
    fullName: form.value.fullName || null,
    phone: form.value.phone || null,
    email: form.value.email || null,
    source: form.value.source || null,
    status: form.value.status || null,
    nextAppointment: form.value.nextAppointmentDate
      ? new Date(form.value.nextAppointmentDate + 'T00:00:00').toISOString()
      : null,
    firstContactDate: form.value.firstContactDate
      ? new Date(form.value.firstContactDate + 'T00:00:00').toISOString()
      : null,
    notes: form.value.notes || null,
  };

  let result: Contact | null;
  if (isNew.value) {
    result = await createContact(payload);
  } else {
    result = await updateContact(props.contact!.id, payload);
  }
  if (!result) return;

  // Push tag set (idempotent — backend computes diff).
  try {
    await api.put(`/contacts/${result.id}/tags`, { tagIds: form.value.tagIds });
  } catch (err) {
    console.error('Failed to update tags:', err);
  }

  emit('saved', result);
  close();
}

async function onDelete() {
  if (!props.contact?.id) return;
  const ok = await deleteContact(props.contact.id);
  if (ok) {
    emit('deleted', props.contact.id);
    close();
  }
}

function close() {
  emit('update:modelValue', false);
}
</script>
