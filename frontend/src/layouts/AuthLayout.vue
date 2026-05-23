<template>
  <!-- Feature 0061 (B): user reverted from variant C (full gradient + glass
       form) to variant B (centered + dashboard peek). Backdrop is plain
       slate; the dashboard-peek skeleton lives inside LoginView so it
       doesn't show on /setup which uses the same layout. -->
  <v-app class="auth-bg">
    <v-main class="d-flex align-center justify-center" style="min-height: 100vh;">
      <v-container style="max-width: 480px;">
        <slot />
      </v-container>
    </v-main>
  </v-app>
</template>

<style scoped>
.auth-bg {
  background: #f5f6fa;
}
</style>
