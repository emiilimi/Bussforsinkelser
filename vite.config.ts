import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { metaImagesPlugin } from "./vite-plugin-meta-images";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    tailwindcss(),
    metaImagesPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    // VITE_APP=reise → eget output (dist/reise) for den frittstående
    // reiseplanlegger-siten. Default-bygget (dist/public) er uendret.
    outDir: path.resolve(
      import.meta.dirname,
      process.env.VITE_APP === "reise" ? "dist/reise" : "dist/public",
    ),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    // `npm run dev:reise` kjører vite alene (VITE_APP=reise). Proxy /api til
    // Express-dev-serveren (kjør `npm run dev` i et annet vindu) så trip/
    // departures/geocoder/parquet virker lokalt før Cloudflare-deploy.
    ...(process.env.VITE_APP === "reise"
      ? { proxy: { "/api": "http://localhost:5000" } }
      : {}),
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
