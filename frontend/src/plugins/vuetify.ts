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
      'smax-light': {
        dark: false,
        colors: {
          background: '#f5f6fa',
          surface: '#ffffff',
          'surface-variant': '#fafbfc',
          'surface-light': '#ffffff',
          primary: '#2962ff',
          secondary: '#1f2330',
          accent: '#2962ff',
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
      'legacy-dark': {
        dark: true,
        colors: {
          background: '#0A192F',
          surface: '#112240',
          'surface-variant': '#1D2D50',
          'surface-light': '#1a3050',
          primary: '#00F2FF',
          secondary: '#E6F1FF',
          accent: '#00F2FF',
          error: '#FF5252',
          warning: '#FFB74D',
          success: '#4CAF50',
          info: '#00F2FF',
          'on-background': '#E6F1FF',
          'on-surface': '#E6F1FF',
          'on-primary': '#0A192F',
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
