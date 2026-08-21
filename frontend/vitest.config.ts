import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Отдельный конфиг, а не блок в vite.config.ts: сборке приложения нужен плагин
// Wails, который в тестах только мешает - биндинги там подменяются, а не
// раздаются с диска.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
