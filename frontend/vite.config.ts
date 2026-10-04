import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Dev server on 3000; /api goes to the c2p server on 5001.
export default defineConfig({
  plugins: [vue()],
  // vue-i18n compile-time flags: Composition API only, no devtools in production.
  define: {
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:5001", changeOrigin: true },
    },
  },
  preview: {
    port: 3000,
    proxy: {
      "/api": { target: "http://127.0.0.1:5001", changeOrigin: true },
    },
  },
});
