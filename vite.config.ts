import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: [
    'monaco-editor/editor/editor.api',
    'monaco-editor/languages/definitions/java/register',
    'monaco-editor/features/find/register',
    'monaco-editor/editor/contrib/clipboard/browser/clipboard',
    'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching',
    'monaco-editor/editor/contrib/comment/browser/comment',
  ] },
  server: { proxy: { '/api': process.env.BLUEPRINTS_API_URL || 'http://127.0.0.1:8000' } },
});
