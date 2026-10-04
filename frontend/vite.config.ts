import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Dev server on 3000; /api goes to the c2p server on 5001.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:5001", changeOrigin: true },
    },
  },
});
