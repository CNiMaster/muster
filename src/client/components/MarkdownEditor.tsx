/**
 * MarkdownEditor · CodeMirror 6 编辑器
 *
 接入 @codemirror/lang-markdown，深色主题对齐 tokens。
 - value/onChange 受控
 - readOnly 用于派生只读视图
 - 高度自适应
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';

export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  minHeight?: number;
}

export function MarkdownEditor({ value, onChange, readOnly = false, placeholder, minHeight = 400 }: MarkdownEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const updateListener = EditorView.updateListener.of((vu) => {
      if (vu.docChanged && onChangeRef.current) {
        onChangeRef.current(vu.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            backgroundColor: 'var(--bg-input)',
            color: 'var(--fg)',
            fontSize: '14px',
            fontFamily: 'var(--font-mono)',
            minHeight: `${minHeight}px`,
          },
          '.cm-content': { caretColor: 'var(--accent)', padding: '12px' },
          '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-subtle)', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
          '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.03)' },
          '&.cm-focused': { outline: 'none' },
          '.cm-cursor': { borderLeftColor: 'var(--accent)' },
          '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(232,134,94,0.25)' },
        }),
        EditorState.readOnly.of(readOnly),
        updateListener,
        EditorView.contentAttributes.of({ 'aria-label': placeholder ?? 'Markdown 编辑器' }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 只在 mount 时建一次；value 变化由下面同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, minHeight]);

  // 外部 value 变化时同步到 view（不触发 onChange）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
      });
    }
  }, [value]);

  return <div className="mu-md-editor" ref={hostRef} />;
}
