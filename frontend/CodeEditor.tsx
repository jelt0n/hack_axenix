import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/features/find/register';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { Diagnostic, SourceRange } from './types';

const normalized = (value: string) => value.replace(/\r\n|\r/g, '\n');

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('blueprints', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: { 'editor.background': '#192537', 'editor.foreground': '#b3c6dc',
    'editorLineNumber.foreground': '#7184a0', 'editor.selectionBackground': '#d99b3340' },
});

export default function CodeEditor({ source, onChange, range, diagnostics }: {
  source: string; onChange: (value: string) => void;
  range: SourceRange | null; diagnostics: Diagnostic[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const props = useRef({ source, onChange }); props.current = { source, onChange };
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const model = monaco.editor.createModel(props.current.source, 'java');
    const instance = monaco.editor.create(container.current!, {
      model, theme: 'blueprints', ariaLabel: 'Рабочая версия Java', automaticLayout: true,
      minimap: { enabled: false }, fontSize: 15, lineHeight: 24, tabSize: 4,
      scrollBeyondLastLine: false, padding: { top: 18, bottom: 18 },
      wordWrap: 'off', quickSuggestions: false, suggestOnTriggerCharacters: false,
      editContext: false,
    });
    editor.current = instance;
    decorations.current = instance.createDecorationsCollection();
    const listener = instance.onDidChangeModelContent(() => {
      const value = model.getValue();
      if (normalized(value) !== normalized(props.current.source)) props.current.onChange(value);
    });
    return () => { listener.dispose(); instance.dispose(); model.dispose(); editor.current = null; };
  }, []);
  useEffect(() => {
    const instance = editor.current;
    if (instance && normalized(instance.getValue()) !== normalized(source)) instance.setValue(source);
  }, [source]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) monaco.editor.setModelMarkers(model, 'java-parser', diagnostics.map(item => ({
      startLineNumber: item.line, endLineNumber: item.line, startColumn: item.column,
      endColumn: item.column + 1, message: item.message, severity: monaco.MarkerSeverity.Error,
    })));
  }, [diagnostics]);
  useEffect(() => {
    if (!range) { decorations.current?.clear(); return; }
    const location = new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn + 1);
    decorations.current?.set([{ range: location, options: { className: 'monaco-source-highlight' } }]);
    editor.current?.revealRangeInCenterIfOutsideViewport(location);
  }, [range]);
  return <div className="java-editor" ref={container} aria-label="Редактор Java" />;
}
