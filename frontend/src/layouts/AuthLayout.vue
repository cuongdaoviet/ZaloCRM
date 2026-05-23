<template>
  <!-- Feature 0061 — login brand voice (variant C from design-shotgun
       2026-05-23). Full-bleed diagonal gradient backdrop with two radial
       glow accents, indigo brand. Replaces the legacy `liquid-bg`
       animated cyan navy whose CSS rules were already stripped in
       Feature 0057. -->
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
  /* Diagonal gradient: indigo-600 → indigo-800 → near-black charcoal */
  background: linear-gradient(135deg, #4f46e5 0%, #4338ca 32%, #1e1b4b 68%, #0b0d12 100%);
  position: relative;
  overflow: hidden;
}
/* Two soft radial glows so the backdrop isn't a flat ramp. Positioned
   to frame the centered form: one upper-left, one lower-right. */
.auth-bg::before,
.auth-bg::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  filter: blur(80px);
  opacity: 0.45;
}
.auth-bg::before {
  width: 480px; height: 480px;
  background: radial-gradient(circle, #818cf8 0%, transparent 70%);
  top: -100px; left: -120px;
}
.auth-bg::after {
  width: 560px; height: 560px;
  background: radial-gradient(circle, #6366f1 0%, transparent 70%);
  bottom: -160px; right: -140px;
}
</style>
