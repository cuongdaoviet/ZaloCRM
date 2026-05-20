<template>
  <div>
    <div v-if="loading && !overview" class="d-flex justify-center pa-8">
      <v-progress-circular indeterminate />
    </div>

    <v-alert v-else-if="error" type="error" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <div v-else-if="overview">
      <!-- Header -->
      <v-card class="mb-4 pa-4">
        <div class="d-flex align-center" style="gap: 16px;">
          <v-avatar size="64" color="primary">
            <v-img v-if="overview.contact.avatarUrl" :src="overview.contact.avatarUrl" />
            <v-icon v-else size="32" color="white">mdi-account</v-icon>
          </v-avatar>

          <div class="flex-grow-1">
            <div class="d-flex align-center" style="gap: 8px;">
              <h1 class="text-h5 mb-0">{{ overview.contact.fullName || 'Chưa có tên' }}</h1>
              <v-chip v-if="overview.contact.status" size="small" color="primary" variant="tonal">
                {{ STATUS_LABELS[overview.contact.status] || overview.contact.status }}
              </v-chip>
            </div>
            <div class="text-body-2 text-grey mt-1">
              <span v-if="overview.contact.phone"><v-icon size="14">mdi-phone</v-icon> {{ overview.contact.phone }}</span>
              <span v-if="overview.contact.email" class="ml-4"><v-icon size="14">mdi-email</v-icon> {{ overview.contact.email }}</span>
              <span v-if="overview.contact.source" class="ml-4"><v-icon size="14">mdi-source-branch</v-icon> {{ overview.contact.source }}</span>
            </div>
            <div v-if="(overview.contact.tags || []).length" class="mt-2">
              <span
                v-for="t in overview.contact.tags"
                :key="t"
                class="mr-1 mb-1 d-inline-block tag-clickable"
                @click="navigateToTag(t)"
              >
                <TagChip
                  :name="t"
                  :color="resolveColor(t)"
                  :emoji="resolveEmoji(t)"
                />
              </span>
            </div>
          </div>

          <div class="text-right text-body-2">
            <div>Phụ trách: <strong>{{ overview.contact.assignedUser?.fullName || '—' }}</strong></div>
            <div v-if="overview.contact.nextAppointment" class="text-warning">
              <v-icon size="14">mdi-calendar-clock</v-icon>
              {{ formatDate(overview.contact.nextAppointment) }}
            </div>
          </div>
        </div>
      </v-card>

      <!-- Stats row -->
      <v-row dense class="mb-4">
        <v-col cols="6" md="3">
          <v-card class="pa-3">
            <div class="text-caption text-grey">Doanh thu trọn đời</div>
            <div class="text-h6 text-success">{{ formatCurrency(overview.stats.lifetimeRevenue) }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card class="pa-3">
            <div class="text-caption text-grey">Đơn đã chốt</div>
            <div class="text-h6">{{ overview.stats.completedOrderCount }} / {{ overview.stats.orderCount }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card class="pa-3">
            <div class="text-caption text-grey">Lịch hẹn</div>
            <div class="text-h6">
              {{ overview.stats.upcomingAppointmentCount }} sắp tới
              <span class="text-body-2 text-grey">/ {{ overview.stats.appointmentCount }} tổng</span>
            </div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card class="pa-3">
            <div class="text-caption text-grey">Tin nhắn</div>
            <div class="text-h6">{{ overview.stats.totalMessages }}</div>
          </v-card>
        </v-col>
      </v-row>

      <v-row dense>
        <!-- Left column: conversation + orders + appointments -->
        <v-col cols="12" md="8">
          <!-- Recent conversation -->
          <v-card class="mb-4">
            <v-card-title class="text-body-1 font-weight-medium d-flex align-center">
              <v-icon class="mr-2">mdi-message-text</v-icon>
              Tin nhắn gần nhất
              <v-spacer />
              <v-btn
                v-if="overview.primaryConversation"
                size="small" variant="text"
                :to="`/chat?conversation=${overview.primaryConversation.id}`"
                prepend-icon="mdi-open-in-new"
              >Mở chat</v-btn>
            </v-card-title>
            <v-divider />
            <div v-if="!overview.primaryConversation" class="pa-4 text-grey text-body-2">
              Chưa có hội thoại nào
            </div>
            <v-list v-else density="compact">
              <v-list-item
                v-for="m in overview.primaryConversation.recentMessages" :key="m.id"
              >
                <template #prepend>
                  <v-icon size="16" :color="m.senderType === 'self' ? 'primary' : 'grey'">
                    {{ m.senderType === 'self' ? 'mdi-account-tie' : 'mdi-account' }}
                  </v-icon>
                </template>
                <v-list-item-title class="text-body-2">{{ m.content || `[${m.contentType}]` }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ formatDate(m.sentAt) }}</v-list-item-subtitle>
              </v-list-item>
              <v-list-item v-if="!overview.primaryConversation.recentMessages.length">
                <span class="text-grey text-body-2">Chưa có tin nhắn</span>
              </v-list-item>
            </v-list>
          </v-card>

          <!-- Orders -->
          <v-card class="mb-4">
            <v-card-title class="text-body-1 font-weight-medium">
              <v-icon class="mr-2">mdi-cart</v-icon>
              Đơn hàng ({{ overview.orders.length }})
            </v-card-title>
            <v-divider />
            <div v-if="!overview.orders.length" class="pa-4 text-grey text-body-2">
              Chưa có đơn hàng nào
            </div>
            <v-list v-else density="compact">
              <v-list-item v-for="o in overview.orders" :key="o.id">
                <v-list-item-title>
                  <strong>{{ o.orderCode }}</strong>
                  <v-chip size="x-small" variant="tonal" class="ml-2">
                    {{ ORDER_STATUS_LABELS[o.status] || o.status }}
                  </v-chip>
                </v-list-item-title>
                <v-list-item-subtitle>
                  {{ formatCurrency(o.totalAmount) }} —
                  {{ o.createdBy?.fullName || 'N/A' }} • {{ formatDate(o.createdAt) }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>

          <!-- Appointments -->
          <v-card class="mb-4">
            <v-card-title class="text-body-1 font-weight-medium">
              <v-icon class="mr-2">mdi-calendar</v-icon>
              Lịch hẹn ({{ overview.appointments.length }})
            </v-card-title>
            <v-divider />
            <div v-if="!overview.appointments.length" class="pa-4 text-grey text-body-2">
              Chưa có lịch hẹn nào
            </div>
            <v-list v-else density="compact">
              <v-list-item v-for="a in overview.appointments" :key="a.id">
                <v-list-item-title>
                  {{ formatDate(a.appointmentDate) }}
                  <span v-if="a.appointmentTime"> — {{ a.appointmentTime }}</span>
                  <v-chip size="x-small" variant="tonal" class="ml-2">
                    {{ APPOINTMENT_STATUS_LABELS[a.status] || a.status }}
                  </v-chip>
                </v-list-item-title>
                <v-list-item-subtitle v-if="a.type || a.assignedUser">
                  <span v-if="a.type">{{ a.type }}</span>
                  <span v-if="a.assignedUser"> • {{ a.assignedUser.fullName }}</span>
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <!-- Right column: notes + activity -->
        <v-col cols="12" md="4">
          <!-- Notes -->
          <v-card class="mb-4">
            <v-card-title class="text-body-1 font-weight-medium">
              <v-icon class="mr-2">mdi-note-text</v-icon>
              Ghi chú ({{ overview.notes.length }})
            </v-card-title>
            <v-divider />
            <div v-if="!overview.notes.length" class="pa-4 text-grey text-body-2">
              Chưa có ghi chú
            </div>
            <v-list v-else density="compact">
              <v-list-item v-for="n in overview.notes" :key="n.id">
                <v-list-item-title class="text-body-2">{{ n.content }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  {{ n.author.fullName }} • {{ formatDate(n.createdAt) }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>

          <!-- Activity timeline -->
          <v-card>
            <v-card-title class="text-body-1 font-weight-medium">
              <v-icon class="mr-2">mdi-history</v-icon>
              Hoạt động
            </v-card-title>
            <v-divider />
            <div v-if="!overview.activity.length" class="pa-4 text-grey text-body-2">
              Chưa có hoạt động
            </div>
            <v-list v-else density="compact">
              <v-list-item v-for="ev in overview.activity" :key="ev.id">
                <template #prepend>
                  <v-icon size="14" :color="ev.user ? 'primary' : 'grey'">
                    {{ ev.user ? 'mdi-account' : 'mdi-robot' }}
                  </v-icon>
                </template>
                <v-list-item-title class="text-body-2">
                  <strong>{{ ev.user?.fullName || 'Hệ thống' }}</strong> {{ ev.action }}
                </v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  {{ formatDate(ev.createdAt) }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>
      </v-row>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  useCustomerOverview,
  STATUS_LABELS,
  ORDER_STATUS_LABELS,
  APPOINTMENT_STATUS_LABELS,
} from '@/composables/use-customer-overview';
import TagChip from '@/components/tags/TagChip.vue';
import { useCrmTags } from '@/composables/use-crm-tags';

const route = useRoute();
const router = useRouter();
const { overview, loading, error, fetchOverview } = useCustomerOverview();

// Feature 0019: enrich chips with color/emoji from the CRM tag cache.
const { loadTags, resolveByName } = useCrmTags();
loadTags();

function resolveColor(name: string): string {
  return resolveByName(name)?.color ?? '#9E9E9E';
}
function resolveEmoji(name: string): string | null {
  return resolveByName(name)?.emoji ?? null;
}

function navigateToTag(name: string) {
  const tag = resolveByName(name);
  if (tag) {
    router.push({ path: '/contacts', query: { tagIds: tag.id } });
  } else {
    // Fall back to name-based query for tags not yet in cache (Phase A).
    router.push({ path: '/contacts', query: { tags: name } });
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('vi-VN');
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
}

onMounted(() => {
  const id = route.params.id as string;
  if (id) fetchOverview(id);
});
</script>

<style scoped>
.tag-clickable {
  cursor: pointer;
}
.tag-clickable:hover {
  filter: brightness(0.95);
}
</style>
