import { useEffect, useRef, useState } from "react";

import { focusRovingItemByKey } from "../a11y.js";
import { BackNavigationButton } from "../back-navigation-button.js";
import type { PromptTemplate } from "../prompt-template.js";
import type { WithMateWindowPromptTemplateApi } from "../withmate-window-api.js";

type PromptTemplateWorkspaceProps = {
  api: WithMateWindowPromptTemplateApi;
  canInsert?: boolean;
  onBack: () => void;
  onInsert: (prompt: string) => void;
};

type PromptTemplateWorkspaceMode = "select" | "edit";

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
  return error instanceof Error ? error.message : "Could not update the template.";
}

export function PromptTemplateWorkspace({ api, canInsert = true, onBack, onInsert }: PromptTemplateWorkspaceProps) {
  const [mode, setMode] = useState<PromptTemplateWorkspaceMode>("select");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const templatesRef = useRef<PromptTemplate[]>([]);
  const pickerListRef = useRef<HTMLDivElement | null>(null);
  const pickerEditButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorNameInputRef = useRef<HTMLInputElement | null>(null);

  const selectedTemplate = templates.find((template) => template.id === editor.id) ?? null;
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
      setIsLoading(false);
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
        setIsLoading(false);
        setError(errorMessage(loadError));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (mode !== "select" || isLoading || typeof document === "undefined") {
      return;
    }
    const pickerList = pickerListRef.current;
    if (pickerList?.contains(document.activeElement)) {
      return;
    }
    const firstSelectableTemplate = pickerList?.querySelector<HTMLElement>("[role=\"option\"]:not([disabled])");
    (firstSelectableTemplate ?? pickerEditButtonRef.current)?.focus();
  }, [canInsert, isLoading, mode, templates]);

  useEffect(() => {
    if (mode === "edit") {
      editorNameInputRef.current?.focus();
    }
  }, [mode]);

  const confirmDiscard = () => !isDirty || window.confirm("Discard unsaved changes?");

  const defaultEditor = templates[0] ? toEditorState(templates[0]) : EMPTY_EDITOR;

  const openEditor = (nextEditor: EditorState = defaultEditor) => {
    if (!confirmDiscard()) {
      return;
    }
    setEditor(nextEditor);
    setMode("edit");
    setError("");
  };

  const returnToPicker = () => {
    if (!confirmDiscard()) {
      return;
    }
    if (isDirty) {
      setEditor(selectedTemplate ? toEditorState(selectedTemplate) : defaultEditor);
    }
    setMode("select");
    setError("");
  };

  const selectTemplateForEditor = (template: PromptTemplate) => {
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
    if (!editor.id || !window.confirm(`Delete "${editor.name}"?`)) {
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

  const handleSelectTemplate = (template: PromptTemplate) => {
    if (!canInsert) {
      return;
    }
    onInsert(template.prompt);
  };

  const renderPicker = () => {
    const hasTemplates = !isLoading && !error && templates.length > 0;
    const pickerRole = hasTemplates ? "listbox" : isLoading || error ? "status" : "region";
    return (
      <>
        <header className="prompt-template-workspace-header">
          <BackNavigationButton
            label="Back to Chat"
            onBack={() => {
              if (confirmDiscard()) {
                onBack();
              }
            }}
          />
          <strong>Templates</strong>
          <button
            ref={pickerEditButtonRef}
            type="button"
            className="drawer-toggle compact secondary"
            onClick={() => openEditor()}
            disabled={isLoading}
            aria-label="Edit template"
          >
            Edit
          </button>
        </header>

        <div className="prompt-template-picker">
          <div
            ref={pickerListRef}
            className="prompt-template-picker-content"
            role={pickerRole}
            aria-label={hasTemplates ? "Template options" : "Template status"}
            aria-orientation={hasTemplates ? "vertical" : undefined}
            aria-busy={isLoading || undefined}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (confirmDiscard()) {
                  onBack();
                }
                return;
              }
              if (event.key === "Enter" && document.activeElement?.getAttribute("role") === "option") {
                event.preventDefault();
                (document.activeElement as HTMLElement).click();
                return;
              }
              if (hasTemplates && document.activeElement?.getAttribute("role") === "option") {
                focusRovingItemByKey(event, { orientation: "vertical", selector: "[role=\"option\"]" });
              }
            }}
          >
            {isLoading ? (
              <div className="prompt-template-picker-state">
                <span className="chat-skill-picker-spinner" aria-hidden="true" />
                <span className="visually-hidden">Loading templates.</span>
              </div>
            ) : error ? (
              <p className="prompt-template-picker-state error" role="alert">{error}</p>
            ) : templates.length > 0 ? (
              templates.map((template, index) => (
                <button
                  key={template.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  tabIndex={canInsert && index === 0 ? 0 : -1}
                  className="prompt-template-picker-item"
                  disabled={!canInsert}
                  title={canInsert ? undefined : "Prompts cannot be inserted in the current session."}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSelectTemplate(template)}
                >
                  <span className="prompt-template-picker-item-primary">{template.name}</span>
                </button>
              ))
            ) : (
              <div className="prompt-template-picker-state">
                <p>No templates yet.</p>
                <button
                  type="button"
                  className="drawer-toggle compact secondary"
                  onClick={() => openEditor(EMPTY_EDITOR)}
                >
                  + New template
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  const renderEditor = () => (
    <>
      <header className="prompt-template-workspace-header">
        <BackNavigationButton label="Back to Template selection" onBack={returnToPicker} />
        <strong>Edit templates</strong>
      </header>

      <div className="prompt-template-workspace-body">
        <aside className="prompt-template-list" aria-label="Template list">
          <button className="drawer-toggle compact secondary" type="button" onClick={createNew}>
            + New
          </button>
          {templates.map((template) => (
            <button
              className={`prompt-template-list-item${editor.id === template.id ? " is-active" : ""}`}
              type="button"
              key={template.id}
              aria-pressed={editor.id === template.id}
              onClick={() => selectTemplateForEditor(template)}
            >
              {template.name}
            </button>
          ))}
        </aside>

        <div className="prompt-template-editor">
          <label>
            <span>Name</span>
            <input
              ref={editorNameInputRef}
              value={editor.name}
              maxLength={120}
              disabled={isSaving}
              onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <textarea
            className="prompt-template-prompt-field"
            aria-label="Prompt"
            value={editor.prompt}
            disabled={isSaving}
            onChange={(event) => setEditor((current) => ({ ...current, prompt: event.target.value }))}
          />
          {error ? <p className="prompt-template-error" role="alert">{error}</p> : null}
          <div className="prompt-template-editor-actions">
            <button
              type="button"
              className="drawer-toggle compact secondary"
              disabled={isSaving || !isDirty}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="drawer-toggle compact danger"
              disabled={isSaving || !editor.id}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <section className="prompt-template-workspace" aria-label="Prompt templates">
      {mode === "select" ? renderPicker() : renderEditor()}
    </section>
  );
}
