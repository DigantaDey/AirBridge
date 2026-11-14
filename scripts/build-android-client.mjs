import { build } from 'vite';

// Ship the UI in the APK. An older/offline desktop must not select Android's
// transfer implementation by serving an old WebView-only JavaScript bundle.
await build({
  build: {
    outDir: 'android/app/build/generated/clientAssets/ui',
    emptyOutDir: true,
  },
});
