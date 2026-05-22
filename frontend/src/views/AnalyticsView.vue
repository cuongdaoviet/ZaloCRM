<template>
  <div>
    <div class="d-flex align-center mb-4 flex-wrap">
      <h1 class="text-h5">Phân tích nâng cao</h1>
      <v-spacer />

      <!-- Date range -->
      <v-text-field
        v-model="dateFrom"
        type="date"
        label="Từ"
        density="compact"
        variant="outlined"
        hide-details
        style="width: 160px;"
        class="mr-2"
      />
      <v-text-field
        v-model="dateTo"
        type="date"
        label="Đến"
        density="compact"
        variant="outlined"
        hide-details
        style="width: 160px;"
        class="mr-2"
      />

      <!-- Team filter -->
      <v-select
        v-model="teamId"
        :items="teamOptions"
        item-title="title"
        item-value="value"
        label="Đội nhóm"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        style="width: 220px;"
        class="mr-2"
        @update:model-value="reload"
      />

      <v-btn color="primary" class="mr-2" :loading="loading" @click="reload">
        Áp dụng
      </v-btn>
      <v-btn icon variant="text" :loading="loading" @click="reload">
        <v-icon>mdi-refresh</v-icon>
        <v-tooltip activator="parent" location="bottom" text="Tải lại" />
      </v-btn>
    </div>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>

    <v-row dense>
      <v-col cols="12" md="5">
        <FunnelChart :data="funnel" />
      </v-col>
      <v-col cols="12" md="7">
        <TeamPerfTable :data="teamPerf" :loading="loading" />
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useAnalytics } from '@/composables/use-analytics';
import { useTeams } from '@/composables/use-teams';
import FunnelChart from '@/components/analytics/FunnelChart.vue';
import TeamPerfTable from '@/components/analytics/TeamPerfTable.vue';

const router = useRouter();
const authStore = useAuthStore();

// Guard — analytics endpoints are admin/owner only; redirect members early so
// they don't see a flash of empty state before getting 403'd.
if (!authStore.isAdmin) {
  router.replace('/');
}

const { funnel, teamPerf, loading, error, fetchAll } = useAnalytics();
const { teams, fetchTeams } = useTeams();

// Default to the last 30 days — matches the backend's default when no
// dateFrom/dateTo is supplied. Pre-filling the inputs makes the active window
// obvious to the user.
const today = new Date();
const thirtyDaysAgo = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
const dateFrom = ref(thirtyDaysAgo.toISOString().slice(0, 10));
const dateTo = ref(today.toISOString().slice(0, 10));
const teamId = ref<string | null>(null);

const teamOptions = computed(() => [
  ...teams.value.map((t) => ({ title: t.name, value: t.id })),
]);

async function reload(): Promise<void> {
  await fetchAll({
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
    teamId: teamId.value ?? undefined,
  });
}

onMounted(async () => {
  await fetchTeams();
  await reload();
});
</script>
