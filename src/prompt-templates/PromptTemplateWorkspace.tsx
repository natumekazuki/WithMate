import { useEffect, useMemo, useRef, useState } from "react";

import type { PromptTemplate } from "../prompt-template.js";
import type { WithMateWindowPromptTemplateApi } from "../withmate-window-api.js";

type PromptTemplateWorkspaceProps = {
  api: WithMateWindowPromptTemplateApi;
  canInsert?: boolean;
  onClose: () => void;
  onInsert: (prompt: string) => void;
};

type EditorState = {
  id: string | null;
  name: string;
  prompt: string;
};

const EMPTY_EDITOR: EditorState = { id: null, name: "", prompt: "" };

function toEditorState(template: PromptTemplate): EditorState {
  return { id: template.id, name: template.name, prompt: template.prompt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "テンプレートを更新できませんでした。";
}

export function PromptTemplateWorkspace({ api, canInsert = true, onClose, onInsert }: PromptTemplateWorkspaceProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const templatesRef = useRef<PromptTemplate[]>([]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === editor.id) ?? null,
    [editor.id, templates],
  );
  const isDirty = selectedTemplate
    ? editor.name !== selectedTemplate.name || editor.prompt !== selectedTemplate.prompt
    : editor.name.length > 0 || editor.prompt.length > 0;

  useEffect(() => {
    let active = true;
    const applyTemplates = (nextTemplates: PromptTemplate[]) => {
      if (!active) {
        return;
      }
      const currentTemplates = templatesRef.current;
      templatesRef.current = nextTemplates;
      setTemplates(nextTemplates);
      setEditor((current) => {
        if (current.id) {
          const nextSelected = nextTemplates.find((template) => template.id === current.id);
          const previousSelected = currentTemplates.find((template) => template.id === current.id);
          if (nextSelected && previousSelected) {
            const hasLocalEdits = current.name !== previousSelected.name || current.prompt !== previousSelected.prompt;
            return hasLocalEdits ? current : toEditorState(nextSelected);
          }
          if (nextSelected) {
            return toEditorState(nextSelected);
          }
        }
        if (current.name || current.prompt) {
          return current;
        }
        return nextTemplates[0] ? toEditorState(nextTemplates[0]) : EMPTY_EDITOR;
      });
    };
    const unsubscribe = api.subscribePromptTemplates(applyTemplates);
    void api.listPromptTemplates().then(applyTemplates).catch((loadError) => {
      if (active) {
        setError(errorMessage(loadError));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const confirmDiscard = () => !isDirty || window.confirm("未保存の変更を破棄しますか？");

  const selectTemplate = (template: PromptTemplate) => {
    if (!confirmDiscard()) {
      return;
    }
    setEditor(toEditorState(template));
    setError("");
  };

  const createNew = () => {
    if (!confirmDiscard()) {
      return;
    }
    setEditor(EMPTY_EDITOR);
    setError("");
  };

  const save = async (): Promise<boolean> => {
    setIsSaving(true);
    setError("");
    try {
      const nextTemplates = editor.id
        ? await api.updatePromptTemplate({ id: editor.id, name: editor.name, prompt: editor.prompt })
        : await api.createPromptTemplate({ name: editor.name, prompt: editor.prompt });
      templatesRef.current = nextTemplates;
      setTemplates(nextTemplates);
      const saved = editor.id
        ? nextTemplates.find((template) => template.id === editor.id)
        : nextTemplates.find((template) => template.name === editor.name.trim().replace(/\s+/g, " "));
      if (saved) {
        setEditor(toEditorState(saved));
      }
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async () => {
    if (!editor.id || !window.confirm(`「${editor.name}」を削除しますか？`)) {
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const nextTemplates = await api.deletePromptTemplate(editor.id);
      templatesRef.current = nextTemplates;
      setTemplates(nextTemplates);
      setEditor(nextTemplates[0] ? toEditorState(nextTemplates[0]) : EMPTY_EDITOR);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsSaving(false);
    }
  };

  const insert = async () => {
    if (isDirty && !(await save())) {
      return;
    }
    onInsert(editor.prompt);
  };

  return (
    <section className="prompt-template-workspace" aria-label="Prompt templates">
      <header className="prompt-template-workspace-header">
        <strong>Templates</strong>
        <button
          className="session-file-back-to-chat"
          type="button"
          onClick={() => {
            if (confirmDiscard()) {
              onClose();
            }
          }}
        >
          戻る
        </button>
      </header>

      <div className="prompt-template-workspace-body">
        <aside className="prompt-template-list" aria-label="Template list">
          <button className="drawer-toggle compact secondary" type="button" onClick={createNew}>
            ＋ 新規
          </button>
          {templates.map((template) => (
            <button
              className={`prompt-template-list-item${editor.id === template.id ? " is-active" : ""}`}
              type="button"
              key={template.id}
              aria-pressed={editor.id === template.id}
              onClick={() => selectTemplate(template)}
            >
              {template.name}
            </button>
          ))}
        </aside>

        <div className="prompt-template-editor">
          <label>
            <span>名前</span>
            <input
              value={editor.name}
              maxLength={120}
              disabled={isSaving}
              onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <textarea
            className="prompt-template-prompt-field"
            aria-label="プロンプト"
            value={editor.prompt}
            disabled={isSaving}
            onChange={(event) => setEditor((current) => ({ ...current, prompt: event.target.value }))}
          />
          {error ? <p className="prompt-template-error" role="alert">{error}</p> : null}
          <div className="prompt-template-editor-actions">
            <button type="button" className="drawer-toggle compact secondary" disabled={isSaving || !isDirty} onClick={() => void save()}>
              保存
            </button>
            <button type="button" className="drawer-toggle compact danger" disabled={isSaving || !editor.id} onClick={() => void remove()}>
              削除
            </button>
            <button
              type="button"
              className="drawer-toggle compact"
              disabled={isSaving || !canInsert || !editor.name.trim() || !editor.prompt.trim()}
              title={canInsert ? undefined : "現在のセッションではプロンプトを挿入できません。"}
              onClick={() => void insert()}
            >
              挿入
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
