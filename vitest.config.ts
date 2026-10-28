import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      /*
       * `import "server-only"` は Next.js のビルドが解決するマーカーで、
       * node_modules には実体が無い。vitest から src/lib/* を読み込むと
       * 「Cannot find package 'server-only'」で落ちるため、
       * Next が同梱している「何もしない」実装に差し替える。
       */
      "server-only": "next/dist/compiled/server-only/empty.js",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 本番（Vercel）は UTC で動く。テストも UTC に固定して本番の挙動を再現する。
    // ここを Asia/Tokyo にすると「JST に変換している」と「たまたまローカルが JST」が
    // 区別できなくなり、日付ずれのバグをテストが検出できなくなる。
    env: { TZ: "UTC" },
  },
});
