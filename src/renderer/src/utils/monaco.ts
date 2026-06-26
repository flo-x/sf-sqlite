import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import type * as monaco from 'monaco-editor'

/**
 * Must be called once before any Monaco editor is created (called from main.ts).
 * Setting MonacoEnvironment here instead of inside each view guarantees it runs
 * exactly once and is ready before any component mounts.
 */
export function setupMonacoEnvironment(): void {
  window.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'javascript' || label === 'typescript') {
        return new TsWorker()
      }
      return new EditorWorker()
    }
  }
}

/** Shared base options for every Monaco editor instance in the app. */
export const EDITOR_BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'vs',
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: 'on',
  scrollBeyondLastLine: false,
  automaticLayout: true,
  wordWrap: 'on',
  renderLineHighlight: 'none'
}
