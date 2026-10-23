import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Code2, LockKeyhole } from 'lucide-react';
import type { GraphNode, JavaMethod, Project, SourceRange } from './types';

const LINE_HEIGHT = 24;
const OVERSCAN = 15;

function Line({ text }: { text: string }) {
  const tokens = text.split(/(\/\/.*$|"(?:\\.|[^"\\])*"|\b(?:public|class|private|static|void|int|if|else|return|new|final|package|import|String|boolean|throw|try|catch|for|while)\b|\b\d+\b)/g);
  return <>{tokens.map((token, i) => <span key={i} className={token.startsWith('//') ? 'syntax-comment'
    : token.startsWith('"') ? 'syntax-string' : /^\d+$/.test(token) ? 'syntax-number'
    : /^(public|class|private|static|void|int|if|else|return|new|final|package|import|String|boolean|throw|try|catch|for|while)$/.test(token) ? 'syntax-keyword' : undefined}>{token}</span>)}</>;
}

export default function SourceView({ project, method, selection, blocks, onSelect, original, onOriginal }: {
  project: Project; method: JavaMethod | null; selection: SourceRange | null;
  blocks: GraphNode[]; onSelect: (block: GraphNode) => void;
  original: boolean; onOriginal: (value: boolean) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const source = original ? project.originalSource : project.generatedSource;
  const lines = useMemo(() => source.split(/\r\n|\r|\n/), [source]);
  const widest = useMemo(() => lines.reduce((length, line) => Math.max(length, line.length), 0), [lines]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    const line = selection?.startLine ?? method?.range.startLine;
    if (!element) return;
    if (!line) {
      element.scrollTop = 0;
      setScrollTop(0);
      return;
    }
    const position = (line - 1) * LINE_HEIGHT;
    if (position < element.scrollTop || position + LINE_HEIGHT > element.scrollTop + height) {
      element.scrollTop = Math.max(0, position - height / 3);
    }
    setScrollTop(element.scrollTop);
  }, [selection, method, height, source]);

  function selectLine(event: MouseEvent<HTMLDivElement>, line: number) {
    const code = event.currentTarget.querySelector('code');
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const fallback = !caret ? document.caretRangeFromPoint?.(event.clientX, event.clientY) : null;
    const offsetNode = caret?.offsetNode ?? fallback?.startContainer;
    const offset = caret?.offset ?? fallback?.startOffset;
    let column: number | null = null;
    if (code && offsetNode && offset !== undefined && code.contains(offsetNode)) {
      const range = document.createRange();
      range.selectNodeContents(code);
      range.setEnd(offsetNode, offset);
      column = range.toString().length + 1;
    }
    const candidates = blocks.filter(node => !['entry', 'exit'].includes(node.kind)
      && node.range.startLine <= line && node.range.endLine >= line
      && (column === null || ((line !== node.range.startLine || column >= node.range.startColumn)
        && (line !== node.range.endLine || column <= node.range.endColumn))));
    const block = candidates.sort((a, b) =>
      (a.range.endLine - a.range.startLine) - (b.range.endLine - b.range.startLine)
      || (a.range.endColumn - a.range.startColumn) - (b.range.endColumn - b.range.startColumn))[0];
    if (block) onSelect(block);
  }
  const first = Math.max(0, Math.min(lines.length - 1, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN));
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN);

  function lineContent(text: string, line: number) {
    if (!selection || line < selection.startLine || line > selection.endLine) return <Line text={text || ' '} />;
    const start = line === selection.startLine ? selection.startColumn - 1 : 0;
    const end = line === selection.endLine ? selection.endColumn : text.length;
    return <><Line text={text.slice(0, start)} /><mark className="source-highlight"><Line text={text.slice(start, end)} /></mark><Line text={text.slice(end)} /></>;
  }
  return (
    <section className="source-panel" aria-label="Исходный код">
      <div className="panel-heading"><div><Code2 size={16} /><span>Java-код</span></div>
        <div className="source-tabs"><button className={!original ? 'active' : ''} onClick={() => onOriginal(false)}>Сгенерированный</button>
          <button className={original ? 'active' : ''} onClick={() => onOriginal(true)}>Исходный</button></div></div>
      <div className="source-path"><span>{project.packageName ? project.packageName.replaceAll('.', ' / ') + ' / ' : ''}{project.filename}</span>
        <span>JAVA</span></div>
      <div className="source-scroll" ref={viewport} tabIndex={0} aria-label="Код программы"
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <div className="source-lines" style={{ height: lines.length * LINE_HEIGHT, minWidth: widest * 7 + 90 }}>
          <div style={{ height: first * LINE_HEIGHT }} aria-hidden="true" />
          {lines.slice(first, last).map((line, index) => { const i = first + index; return <div key={i} data-testid={`source-line-${i + 1}`}
          className={`source-line ${selection && i + 1 >= selection.startLine && i + 1 <= selection.endLine ? 'highlighted' : ''}`}
          onClick={event => selectLine(event, i + 1)}>
          <span className="line-number">{i + 1}</span><code>{lineContent(line, i + 1)}</code>
        </div>; })}</div>
      </div>
      <div className="source-footer"><span><LockKeyhole size={12} />Только чтение</span><span>{lines.length} строк · UTF-8</span></div>
    </section>
  );
}
