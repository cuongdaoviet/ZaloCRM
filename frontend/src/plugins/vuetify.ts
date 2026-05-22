import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';

/**
 * Vuetify theme — Smax-light là default (ported từ ZaloCRM-3.0 với palette
 * design tokens Smax). `legacy-dark` giữ lại để toggle "ban đêm" qua nút
 * sun/moon. Người dùng mới mặc định nhìn thấy Smax-light.
 */
export const vuetify = createVuetify({
  components,
  directives,
  theme: {
    // localStorage stores 'light' | 'dark' (user-facing key, set by
    // DefaultLayout). Map to actual Vuetify theme names. Default for
    // first-time users is the new Smax-light.
    defaultTheme: localStorage.getItem('theme') === 'dark' ? 'legacy-dark' : 'smax-light',
    themes: {
      // Feature 0057 — Slate + Indigo (variant A from design-shotgun
      // 2026-05-22). The old #2962ff bright blue and #00F2FF electric
      // cyan were both too consumer-y / loud for a B2B CRM. Both themes
      // now use the same indigo brand color, just shifted in lightness
      // so dark mode stays legible.
      'smax-light': {
        dark: false,
        colors: {
          background: '#f5f6fa',
          surface: '#ffffff',
          'surface-variant': '#fafbfc',
          'surface-light': '#ffffff',
          primary: '#4f46e5',         // indigo-600
          secondary: '#1f2330',        // header bar / nav
          accent: '#4f46e5',
          error: '#ff3d00',
          warning: '#ff9100',
          success: '#00c853',
          info: '#2196f3',
          'on-background': '#212121',
          'on-surface': '#212121',
          'on-primary': '#ffffff',
          'on-secondary': '#ffffff',
        },
      },
      // Theme key is kept as 'legacy-dark' so the existing toggle wiring
      // in DefaultLayout (which writes 'dark' to localStorage and maps
      // it to 'legacy-dark') doesn't break. But the palette is no longer
      // the legacy navy/cyan — it's a modern charcoal + indigo so the
      // sun/moon toggle now leads to a coherent professional dark mode.
      'legacy-dark': {
        dark: true,
        colors: {
          background: '#0b0d12',       // near-black charcoal
          surface: '#14171f',          // panel surface
          'surface-variant': '#1a1e28',
          'surface-light': '#232834',  // borders / dividers
          primary: '#818cf8',          // indigo-400 (lighter for dark contrast)
          secondary: '#e6e8ee',
          accent: '#818cf8',
          error: '#ff6b6b',
          warning: '#ffa94d',
          success: '#4ade80',
          info: '#60a5fa',
          'on-background': '#e6e8ee',
          'on-surface': '#e6e8ee',
          'on-primary': '#0b0d12',
        },
      },
    },
  },
  defaults: {
    VBtn: { variant: 'flat', rounded: 'lg' },
    VTextField: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VSelect: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VAutocomplete: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VTextarea: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VCard: { rounded: 'md', variant: 'flat' },
    VChip: { rounded: 'lg', size: 'small' },
    VDialog: { maxWidth: 600 },
  },
});
