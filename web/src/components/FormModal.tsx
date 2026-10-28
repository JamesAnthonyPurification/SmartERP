import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Button, ErrorBox, Field, Modal } from './ui';

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'email' | 'date' | 'month' | 'password' | 'textarea' | 'select' | 'checkbox' | 'tel';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  span?: 2;
  step?: string;
  /** Hide the field based on the current values. */
  when?: (values: Record<string, any>) => boolean;
}

/**
 * Generic create/edit form. Empty strings become null and number fields are
 * converted, so payloads match the API's validation schemas.
 */
export function FormModal({
  open, title, fields, initial, onClose, onSubmit, submitLabel = 'Save', size, children,
}: {
  open: boolean;
  title: string;
  fields: FieldDef[];
  initial?: Record<string, any>;
  onClose: () => void;
  onSubmit: (values: Record<string, any>) => Promise<unknown>;
  submitLabel?: string;
  size?: 'md' | 'wide';
  children?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const start: Record<string, any> = {};
      for (const f of fields) start[f.name] = initial?.[f.name] ?? (f.type === 'checkbox' ? false : '');
      setValues(start);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (name: string, v: any) => setValues((s) => ({ ...s, [name]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const out: Record<string, any> = {};
      for (const f of fields) {
        if (f.when && !f.when(values)) continue;
        const v = values[f.name];
        if (f.type === 'number') out[f.name] = v === '' || v === null ? null : Number(v);
        else if (f.type === 'checkbox') out[f.name] = !!v;
        else out[f.name] = v === '' ? null : v;
      }
      await onSubmit(out);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size={size}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} type="submit" form="form-modal">{submitLabel}</Button>
        </>
      }
    >
      <form id="form-modal" onSubmit={submit} className="stack">
        <ErrorBox error={error} />
        <div className="form-grid">
          {fields
            .filter((f) => !f.when || f.when(values))
            .map((f) => {
              const common = {
                name: f.name,
                required: f.required,
                placeholder: f.placeholder,
                value: values[f.name] ?? '',
                onChange: (e: any) => set(f.name, e.target.value),
              };
              if (f.type === 'checkbox') {
                return (
                  <label key={f.name} className={`checkbox ${f.span === 2 ? 'span-2' : ''}`}>
                    <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                    {f.label}
                  </label>
                );
              }
              return (
                <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint} className={f.span === 2 ? 'span-2' : ''}>
                  {f.type === 'select' ? (
                    <select className="select" {...common}>
                      {!f.required && <option value="">—</option>}
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea className="textarea" {...common} />
                  ) : (
                    <input className="input" type={f.type ?? 'text'} step={f.step ?? (f.type === 'number' ? 'any' : undefined)} {...common} />
                  )}
                </Field>
              );
            })}
        </div>
        {children}
      </form>
    </Modal>
  );
}
