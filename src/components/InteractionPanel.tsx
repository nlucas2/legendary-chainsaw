import { useId, useMemo, useState } from "react";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { MarkdownContent } from "./MarkdownContent";
import { ExternalLink } from "./ExternalLink";
import type { PendingInteraction } from "../lib/types";
import "./chat-controls.css";

export function InteractionPanel({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond: (interaction: PendingInteraction, response: unknown) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [choice, setChoice] = useState("");
  const choiceName = useId();
  const [feedback, setFeedback] = useState("");
  const data = interaction.data;
  const choices = stringList(data.choices);
  const planActions = stringList(data.actions);
  const [planAction, setPlanAction] = useState(
    planActions.includes(String(data.recommendedAction)) ? String(data.recommendedAction) : planActions[0] ?? "",
  );
  const schema = record(data.requestedSchema);
  const properties = record(schema.properties);
  const [fields, setFields] = useState<Record<string, unknown>>(() => initialElicitationFields(data.requestedSchema));
  const formValidation = useMemo<CompiledElicitationSchema>(() => interaction.kind === "elicitation" && data.mode !== "url"
    ? compileElicitationSchema(data.requestedSchema) : {}, [interaction.kind, data.mode, data.requestedSchema]);
  const schemaError = data.mode !== undefined && data.mode !== "form" && data.mode !== "url"
    ? "Unsupported elicitation mode." : formValidation.error;

  function updateField(name: string, value: unknown) {
    const next = { ...fields };
    if (value === undefined) delete next[name];
    else next[name] = value;
    setFields(next);
    if (error) setError(validateElicitationContent(formValidation, next));
  }

  async function respond(response: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onRespond(interaction, response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="interaction-panel" aria-label="Copilot needs your input">
      <strong>Input needed</strong>
      {interaction.kind === "user_input" && (
        <form onSubmit={(event) => {
          event.preventDefault();
          void respond({ answer: answer.trim() || choice, wasFreeform: !!answer.trim() });
        }}>
          <p>{text(data.question)}</p>
          {choices.length > 0 && (
            <fieldset className="interaction-choices" disabled={busy}>
              <legend>Choose an answer</legend>
              {choices.map((value, index) => <label key={`${index}-${value}`}>
                <input type="radio" name={choiceName} value={value} checked={choice === value}
                  onChange={() => { setChoice(value); setAnswer(""); }} />
                <span>{value}</span>
              </label>)}
            </fieldset>
          )}
          {(data.allowFreeform !== false || choices.length === 0) && (
            <label>{choices.length ? "Or type your answer" : "Your answer"}<textarea value={answer}
              onChange={(event) => { setAnswer(event.target.value); setChoice(""); }} disabled={busy} /></label>
          )}
          <button className="button primary" disabled={busy || (!answer.trim() && !choice)}>Submit answer</button>
        </form>
      )}
      {interaction.kind === "elicitation" && (
        // AJV owns submission validity: required is presence, and JSON Schema
        // lengths count Unicode characters rather than HTML's UTF-16 units.
        <form noValidate onBlur={() => {
          if (data.mode !== "url" && !schemaError) setError(validateElicitationContent(formValidation, fields));
        }} onSubmit={(event) => {
          event.preventDefault();
          if (schemaError) { setError(schemaError); return; }
          if (data.mode === "url") { void respond({ action: "accept" }); return; }
          const invalid = validateElicitationContent(formValidation, fields);
          if (invalid) { setError(invalid); return; }
          void respond({ action: "accept", content: fields });
        }}>
          <p>{text(data.message)}</p>
          {schemaError ? <p role="alert">{schemaError}</p> : data.mode === "url" ? (
            safeExternalUrl(data.url) ? (
              <p><ExternalLink href={safeExternalUrl(data.url)}>Open requested page</ExternalLink></p>
            ) : <p role="alert">The runtime supplied an unsupported URL.</p>
          ) : Object.entries(properties).map(([name, raw]) => {
            const field = record(raw);
            const options = fieldOptions(field);
            const required = stringList(schema.required).includes(name);
            const value = fields[name];
            return (
              <label key={name}>
                {text(field.title) || name}{required ? " *" : ""}
                {text(field.description) && <small>{text(field.description)}</small>}
                {(typeof field.minLength === "number" || typeof field.maxLength === "number") &&
                  <small>Length: {typeof field.minLength === "number" ? field.minLength : 0}–{typeof field.maxLength === "number" ? field.maxLength : "unlimited"} Unicode characters.</small>}
                {field.type === "boolean" ? (
                  <input type="checkbox" checked={value === true} disabled={busy} aria-required={required}
                    onChange={(event) => updateField(name, event.target.checked)} />
                ) : options.length > 0 ? (
                  <select value={options.some((option) => option.value === value) ? String(options.findIndex((option) => option.value === value)) : ""}
                    required={required} disabled={busy}
                    onChange={(event) => updateField(name, event.target.value === "" ? undefined : options[Number(event.target.value)].value)}>
                    <option value="">Select...</option>
                    {options.map((option, index) => <option key={index} value={String(index)}>{option.label || "(empty)"}</option>)}
                  </select>
                ) : field.type === "array" ? (
                  <select multiple value={stringList(value)} disabled={busy} required={required}
                    onChange={(event) => {
                      const selected = Array.from(event.target.selectedOptions, (option) => option.value);
                      updateField(name, selected.length === 0 && !required ? undefined : selected);
                    }}>
                    {fieldOptions(record(field.items)).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input type={field.type === "number" || field.type === "integer" ? "number"
                    : field.format === "email" ? "email" : field.format === "date" ? "date" : "text"}
                    step={field.type === "integer" ? "1" : "any"}
                    min={typeof field.minimum === "number" ? field.minimum : undefined}
                    max={typeof field.maximum === "number" ? field.maximum : undefined}
                    value={typeof value === "string" || typeof value === "number" ? value : ""}
                    required={required} disabled={busy}
                    inputMode={field.format === "uri" ? "url" : field.format === "email" ? "email" : undefined}
                    placeholder={field.format === "date-time" ? "YYYY-MM-DDTHH:mm:ssZ" : undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      const numeric = field.type === "number" || field.type === "integer";
                      updateField(name, value === "" && (numeric || !required) ? undefined : numeric ? Number(value) : value);
                    }} />
                )}
              </label>
            );
          })}
          <div className="interaction-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => void respond({ action: "cancel" })}>Cancel</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => void respond({ action: "decline" })}>Decline</button>
            <button className="button primary" disabled={busy || Boolean(schemaError)}>Submit</button>
          </div>
        </form>
      )}
      {interaction.kind === "exit_plan_mode" && (
        <form onSubmit={(event) => {
          event.preventDefault();
          void respond({ approved: true, selectedAction: planAction, autoApproveEdits: false, feedback });
        }}>
          <p>{text(data.summary)}</p>
          <div className="plan-preview"><MarkdownContent>{text(data.planContent)}</MarkdownContent></div>
          <label>
            Continue with
            <select value={planAction} onChange={(event) => setPlanAction(event.target.value)} disabled={busy}>
              {planActions.map((action) => <option key={action} value={action}>{action.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <label>Feedback<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} /></label>
          <small>Existing tool permission rules remain in effect.</small>
          <div className="interaction-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => void respond({ approved: false, feedback })}>Request changes</button>
            <button className="button primary" disabled={busy || !planAction}>Approve plan</button>
          </div>
        </form>
      )}
      {interaction.kind === "auto_mode_switch" && (
        <>
          <p>The current model is rate-limited. Allow the runtime to select an available model?</p>
          <div className="interaction-actions">
            <button className="button secondary" disabled={busy} onClick={() => void respond("no")}>Keep current model</button>
            <button className="button primary" disabled={busy} onClick={() => void respond("yes")}>Switch once</button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export interface CompiledElicitationSchema {
  validate?: ValidateFunction;
  error?: string;
}

export function initialElicitationFields(raw: unknown): Record<string, unknown> {
  const schema = record(raw);
  const required = new Set(stringList(schema.required));
  return Object.fromEntries(Object.entries(record(schema.properties)).flatMap(([name, rawField]) => {
    const field = record(rawField);
    if (field.default !== undefined) return [[name, Array.isArray(field.default) ? [...field.default] : field.default]];
    // `required` means presence, not truthiness. HTML required checkboxes would
    // incorrectly forbid the valid answer false.
    if (required.has(name) && field.type === "boolean") return [[name, false]];
    if (required.has(name) && field.type === "array") return [[name, []]];
    return [];
  }));
}

export function compileElicitationSchema(raw: unknown): CompiledElicitationSchema {
  try {
    const schema = elicitationSchemaProfile(raw);
    const ajv = new Ajv2020({
      allErrors: true, strict: true, ownProperties: true,
      coerceTypes: false, useDefaults: false, removeAdditional: false,
    });
    addFormats(ajv, { mode: "full", formats: ["email", "uri", "date", "date-time"] });
    ajv.addKeyword({
      keyword: "enumNames", schemaType: "array", valid: true,
      metaSchema: { type: "array", items: { type: "string" } },
    });
    return { validate: ajv.compile({ ...schema, additionalProperties: false }) };
  } catch (cause) {
    return { error: `Unsupported or invalid elicitation schema: ${String(cause instanceof Error ? cause.message : cause).slice(0, 500)}` };
  }
}

export function validateElicitationContent(compiled: CompiledElicitationSchema, content: unknown): string {
  if (compiled.error) return compiled.error;
  if (!compiled.validate) return "Unsupported elicitation schema.";
  if (compiled.validate(content)) return "";
  const errors = compiled.validate.errors ?? [];
  const error = errors.find((item) => item.instancePath) ?? errors[0];
  if (!error) return "Invalid elicitation response.";
  const path = error.instancePath || (typeof error.params.missingProperty === "string" ? `/${error.params.missingProperty}` : "/");
  return `${path}: ${error.message ?? "invalid value"}`;
}

function schemaObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a schema object.");
  const object = value as Record<string, unknown>;
  const unsupported = Object.keys(object).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`Keyword ${unsupported} is not supported.`);
  return object;
}

function checkEnum(schema: Record<string, unknown>, titledKey: "oneOf" | "anyOf") {
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every((value) => typeof value === "string")) {
      throw new Error("Enums must contain string choices.");
    }
    if (schema[titledKey] !== undefined) throw new Error("Mixed enum encodings are not supported.");
    if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) ||
      schema.enumNames.length !== schema.enum.length || !schema.enumNames.every((value) => typeof value === "string"))) {
      throw new Error("enumNames must label every string choice.");
    }
  } else if (schema.enumNames !== undefined) throw new Error("enumNames requires enum.");
  const choices = schema[titledKey];
  if (choices !== undefined) {
    if (!Array.isArray(choices) || !choices.length) throw new Error("Titled enums require choices.");
    for (const raw of choices) {
      const choice = schemaObject(raw, ["const", "title"]);
      if (typeof choice.const !== "string" || (choice.title !== undefined && typeof choice.title !== "string")) {
        throw new Error("Titled enum choices must have string const/title.");
      }
    }
  }
}

// Capability/profile check only. AJV performs actual JSON Schema validation.
function elicitationSchemaProfile(raw: unknown): Record<string, unknown> {
  const schema = schemaObject(raw, ["$schema", "type", "properties", "required", "title", "description", "additionalProperties"]);
  if (schema.type !== "object") throw new Error("Form root must be an object.");
  if (schema.$schema !== undefined && ![
    "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#",
  ].includes(String(schema.$schema))) throw new Error("Only the JSON Schema 2020-12 form dialect is supported.");
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error("Only declared form fields are supported.");
  }
  if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error("properties must be an object.");
  }
  const properties = schema.properties as Record<string, unknown>;
  if (schema.required !== undefined && (!Array.isArray(schema.required) ||
    !schema.required.every((name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(properties, name)))) {
    throw new Error("required must name declared fields.");
  }
  const common = ["type", "title", "description", "default"];
  for (const rawField of Object.values(properties)) {
    const type = record(rawField).type;
    let allowed: string[];
    switch (type) {
      case "string": allowed = [...common, "minLength", "maxLength", "pattern", "format", "enum", "enumNames", "oneOf"]; break;
      case "number": case "integer": allowed = [...common, "minimum", "maximum"]; break;
      case "boolean": allowed = common; break;
      case "array": allowed = [...common, "minItems", "maxItems", "items"]; break;
      default: throw new Error("Only primitive fields and string-enum arrays are supported.");
    }
    const field = schemaObject(rawField, allowed);
    if (type === "string") {
      checkEnum(field, "oneOf");
      if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(String(field.format))) {
        throw new Error("Unsupported string format.");
      }
    }
    if (type === "array") {
      const items = schemaObject(field.items, ["type", "enum", "enumNames", "anyOf"]);
      checkEnum(items, "anyOf");
      if (items.enum !== undefined ? items.type !== "string" :
        items.anyOf === undefined || (items.type !== undefined && items.type !== "string")) {
        throw new Error("Array items must be a string enum.");
      }
    }
  }
  return schema;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function fieldOptions(field: Record<string, unknown>): { value: string; label: string }[] {
  if (Array.isArray(field.enum)) return stringList(field.enum).map((value, i) => ({
    value, label: stringList(field.enumNames)[i] ?? value,
  }));
  const choices = field.oneOf ?? field.anyOf;
  return Array.isArray(choices) ? choices.flatMap((raw) => {
    const option = record(raw);
    return typeof option.const === "string" ? [{ value: option.const, label: text(option.title) || option.const }] : [];
  }) : [];
}
function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; }
  catch { return undefined; }
}
