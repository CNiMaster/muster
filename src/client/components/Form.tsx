/**
 * Form 控件：Input / Select / Textarea / Field
 *
 - 统一 label + 错误提示
 - focus ring 键盘可见
 - 触达 ≥40px（输入框高 40px + padding）
 */
import React, { useId } from 'react';

export interface FieldProps {
  label?: React.ReactNode;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, error, hint, required, children, className }: FieldProps): React.ReactElement {
  const generatedId = useId();
  const child = React.isValidElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(children)
    ? children
    : null;
  const controlId = child?.props.id ?? `field-${generatedId.replace(/:/g, '')}`;
  const descriptionId = hint || error ? `${controlId}-description` : undefined;
  const control = child ? React.cloneElement(child, {
    id: controlId,
    'aria-describedby': child.props['aria-describedby'] ?? descriptionId,
    'aria-invalid': child.props['aria-invalid'] ?? (error ? true : undefined),
  }) : children;
  return (
    <div className={`mu-field ${error ? 'has-error' : ''} ${className ?? ''}`}>
      {label && (
        <label className="mu-field-label" htmlFor={controlId}>
          {label}
          {required && <span className="mu-field-required" aria-hidden="true">*</span>}
        </label>
      )}
      {control}
      {hint && !error && <div id={descriptionId} className="mu-field-hint">{hint}</div>}
      {error && <div id={descriptionId} className="mu-field-error" role="alert">{error}</div>}
    </div>
  );
}

const inputBaseClass = 'mu-input';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps): React.ReactElement {
  return <input className={`${inputBaseClass} ${invalid ? 'is-invalid' : ''} ${className ?? ''}`} {...rest} />;
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps): React.ReactElement {
  return <textarea className={`mu-input mu-textarea ${invalid ? 'is-invalid' : ''} ${className ?? ''}`} {...rest} />;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ invalid, className, children, ...rest }: SelectProps): React.ReactElement {
  return (
    <select className={`mu-input mu-select ${invalid ? 'is-invalid' : ''} ${className ?? ''}`} {...rest}>
      {children}
    </select>
  );
}
