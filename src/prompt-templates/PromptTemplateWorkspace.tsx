import { useEffect, useRef, useState } from "react";

import { focusRovingItemByKey } from "../ui/a11y.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import { ButtonContent } from "../ui/button-content.js";
import { CloseButton } from "../ui/close-button.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import type { PromptTemplate } from "../../src-shared/prompt-template.js";
import type { WithMateWindowPromptTemplateApi } from "../../src-shared/ipc/withmate-window-api.js";

type PromptTemplateWorkspaceProps = {
  api: WithMateWindowPromptTemplateApi;
  canInsert?: boolean;
  onRegisterCloseGuard?: (guard: (() => boolean) | null) => void;
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

export function PromptTemplateWorkspace({
  api,
  canInsert = true,
  onRegisterCloseGuard,
  onBack,
  onInsert,
}: PromptTemplateWorkspaceProps) {
  const [mode, setMode] = useState<PromptTemplateWorkspaceMode>("select");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [savingAction, setSavingAction] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState("");
  const templatesRef = useRef<PromptTemplate[]>([]);
  const pickerListRef = useRef<HTMLDivElement | null>(null);
  const pickerEditButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerRetryButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorNameInputRef = useRef<HTMLInputElement | null>(null);
  const shouldFocusPickerRef = useRef(true);
  const isSaving = savingAction !== null;

  const selectedTemplate = templates.find((template) => template.id === editor.id) ?? null;
  const isDirty = selectedTemplate
    ? editor.name !== selectedTemplate.name || editor.prompt !== selectedTemplate.prompt
    : editor.name.length > 0 || editor.prompt.length > 0;
  const closeGuardRef = useRef<() => boolean>(() => true);
  closeGuardRef.current = () => !isSaving && (!isDirty || window.confirm("Discard unsaved changes?"));

  useEffect(() => {
    if (!onRegisterCloseGuard) {
      return;
    }
    const guard = () => closeGuardRef.current();
    onRegisterCloseGuard(guard);
    return () => onRegisterCloseGuard(null);
  }, [onRegisterCloseGuard]);

  useEffect(() => {
    let active = true;
    let receivedNotification = false;
    setIsLoading(true);
    setLoadError("");
    const applyTemplates = (nextTemplates: PromptTemplate[]) => {
      if (!active) {
        return;
      }
      const currentTemplates = templatesRef.current;
      templatesRef.current = nextTemplates;
      setTemplates(nextTemplates);
      setIsLoading(false);
      setLoadError("");
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
    const unsubscribe = api.subscribePromptTemplates((nextTemplates) => {
      receivedNotification = true;
      applyTemplates(nextTemplates);
    });
    void api.listPromptTemplates().then((nextTemplates) => {
      if (!receivedNotification) applyTemplates(nextTemplates);
    }).catch((loadError) => {
      if (active && !receivedNotification) {
        setIsLoading(false);
        setLoadError(loadError instanceof Error ? loadError.message : "Could not load templates.");
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, loadAttempt]);

  useEffect(() => {
    if (mode !== "select") {
      shouldFocusPickerRef.current = true;
      return;
    }
    if (!shouldFocusPickerRef.current || typeof document === "undefined") {
      return;
    }
    const pickerList = pickerListRef.current;
    if (isLoading) {
      pickerList?.focus();
      return;
    }
    if (document.activeElement !== pickerList && pickerList?.contains(document.activeElement)) {
      shouldFocusPickerRef.current = false;
      return;
    }
    const firstSelectableTemplate = pickerList?.querySelector<HTMLElement>("[role=\"option\"]:not([disabled])");
    (firstSelectableTemplate ?? pickerRetryButtonRef.current ?? pickerEditButtonRef.current)?.focus();
    shouldFocusPickerRef.current = false;
  }, [isLoading, loadError, mode]);

  useEffect(() => {
    if (mode === "edit") {
      editorNameInputRef.current?.focus();
    }
  }, [mode]);

  const confirmDiscard = () => closeGuardRef.current();

  const defaultEditor = templates[0] ? toEditorState(templates[0]) : EMPTY_EDITOR;

  const openEditor = (nextEditor: EditorState = defaultEditor) => {
    if (isLoading || loadError || !confirmDiscard()) {
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
    setSavingAction("save");
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
      setSavingAction(null);
    }
  };

  const remove = async () => {
    if (!editor.id || !window.confirm(`Delete "${editor.name}"?`)) {
      return;
    }
    setSavingAction("delete");
    setError("");
    try {
      const nextTemplates = await api.deletePromptTemplate(editor.id);
      templatesRef.current = nextTemplates;
      setTemplates(nextTemplates);
      setEditor(nextTemplates[0] ? toEditorState(nextTemplates[0]) : EMPTY_EDITOR);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setSavingAction(null);
    }
  };

  const handleSelectTemplate = (template: PromptTemplate) => {
    if (!canInsert) {
      return;
    }
    onInsert(template.prompt);
  };

  const renderPicker = () => {
    const hasTemplates = !isLoading && !loadError && templates.length > 0;
    const pickerRole = hasTemplates ? "listbox" : isLoading || loadError ? "status" : "region";
    return (
      <>
        <header className="prompt-template-workspace-header">
          <strong>Templates</strong>
          <div className="prompt-template-workspace-header-actions">
            <button
              ref={pickerEditButtonRef}
              type="button"
              className="drawer-toggle compact secondary"
              onClick={() => openEditor()}
              disabled={isLoading || Boolean(loadError)}
              aria-label="Edit template"
            >
              Edit Templates
            </button>
            <CloseButton
              ariaLabel="Close templates"
              onClose={() => {
                if (confirmDiscard()) {
                  onBack();
                }
              }}
            />
          </div>
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
                <LoadingIndicator label="Loading templates" />
              </div>
            ) : loadError ? (
              <div className="prompt-template-picker-state error">
                <p role="alert">{loadError}</p>
                <button
                  ref={pickerRetryButtonRef}
                  type="button"
                  className="drawer-toggle compact secondary"
                  onClick={() => {
                    shouldFocusPickerRef.current = true;
                    setLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </button>
              </div>
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
                <button
                  type="button"
                  className="drawer-toggle compact secondary"
                  onClick={() => openEditor(EMPTY_EDITOR)}
                  aria-label="New template"
                  title="New template"
                >
                  <span className="composer-attachment-trigger-plus" aria-hidden="true">＋</span>
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
        <BackNavigationButton label="Back to template selection" onBack={returnToPicker} disabled={isSaving} />
        <strong>Edit Templates</strong>
      </header>

      <div className="prompt-template-workspace-body">
        <aside className="prompt-template-list" aria-label="Template list">
          <button
            className="drawer-toggle compact secondary"
            type="button"
            onClick={createNew}
            disabled={isSaving}
            aria-label="New template"
            title="New template"
          >
            <span className="composer-attachment-trigger-plus" aria-hidden="true">＋</span>
          </button>
          {templates.map((template) => (
            <button
              className={`prompt-template-list-item${editor.id === template.id ? " is-active" : ""}`}
              type="button"
              key={template.id}
              aria-pressed={editor.id === template.id}
              disabled={isSaving}
              onClick={() => selectTemplateForEditor(template)}
            >
              {template.name}
            </button>
          ))}
        </aside>

        <div className="prompt-template-editor">
          <input
            ref={editorNameInputRef}
            aria-label="Template name"
            value={editor.name}
            maxLength={120}
            disabled={isSaving}
            onChange={(event) => {
              const value = event.target.value;
              setEditor((current) => ({ ...current, name: value }));
            }}
          />
          <textarea
            className="prompt-template-prompt-field"
            aria-label="Prompt"
            value={editor.prompt}
            disabled={isSaving}
            onChange={(event) => {
              const value = event.target.value;
              setEditor((current) => ({ ...current, prompt: value }));
            }}
          />
          {error ? <p className="prompt-template-error" role="alert">{error}</p> : null}
          <div className="prompt-template-editor-actions">
            <button
              type="button"
              className="drawer-toggle compact secondary"
              disabled={isSaving || !isDirty}
              aria-busy={savingAction === "save" || undefined}
              aria-label={savingAction === "save" ? "Saving template" : "Save"}
              onClick={() => void save()}
            >
              <ButtonContent busy={savingAction === "save"}>Save Template</ButtonContent>
            </button>
            <button
              type="button"
              className="drawer-toggle compact danger"
              disabled={isSaving || !editor.id}
              aria-busy={savingAction === "delete" || undefined}
              aria-label={savingAction === "delete" ? "Deleting template" : "Delete"}
              onClick={() => void remove()}
            >
              <ButtonContent busy={savingAction === "delete"}>Delete Template</ButtonContent>
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
