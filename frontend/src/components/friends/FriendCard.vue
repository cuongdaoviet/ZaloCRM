<template>
  <v-card class="friend-card pa-3 d-flex flex-column" variant="outlined">
    <div class="d-flex align-center">
      <v-avatar size="56" color="grey-lighten-3" class="friend-card__avatar">
        <v-img
          v-if="friend.contact?.avatarUrl || friend.avatarUrl"
          :src="(friend.contact?.avatarUrl ?? friend.avatarUrl) as string"
        />
        <v-icon v-else size="32">mdi-account</v-icon>
      </v-avatar>
      <div class="flex-grow-1 ml-3 overflow-hidden">
        <div class="text-body-1 font-weight-medium text-truncate">
          {{ displayName }}
        </div>
        <div
          v-if="friend.contact?.phone"
          class="text-caption text-medium-emphasis text-truncate"
        >
          {{ friend.contact.phone }}
        </div>
        <v-chip
          v-if="friend.zaloAccountName"
          size="x-small"
          variant="tonal"
          color="primary"
          class="mt-1"
          prepend-icon="mdi-cellphone-link"
        >
          {{ friend.zaloAccountName }}
        </v-chip>
      </div>
    </div>

    <v-spacer />

    <div class="d-flex align-center mt-3 ga-2">
      <v-btn
        v-if="friend.contactId"
        :to="`/contacts/${friend.contactId}`"
        size="small"
        variant="tonal"
        prepend-icon="mdi-account-eye"
        density="comfortable"
        class="flex-grow-1"
      >Xem Contact</v-btn>
      <v-btn
        v-else
        size="small"
        variant="tonal"
        color="secondary"
        prepend-icon="mdi-account-plus"
        density="comfortable"
        class="flex-grow-1"
        @click="$emit('create-contact', friend)"
      >Tạo Contact</v-btn>
    </div>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FriendListItem } from '@/composables/use-friends';

const props = defineProps<{
  friend: FriendListItem;
}>();

defineEmits<{
  'create-contact': [friend: FriendListItem];
}>();

const displayName = computed(() => {
  return (
    props.friend.contact?.fullName ||
    props.friend.displayName ||
    'Bạn không tên'
  );
});
</script>

<style scoped>
.friend-card {
  height: 100%;
  border-radius: var(--smax-radius-lg, 9px);
  transition: box-shadow 0.15s ease-in-out, transform 0.15s ease-in-out;
}

.friend-card:hover {
  box-shadow: 0 4px 16px rgba(41, 98, 255, 0.08);
  transform: translateY(-1px);
}

.friend-card__avatar {
  flex-shrink: 0;
}
</style>
