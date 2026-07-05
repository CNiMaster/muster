/**
 * Form 控件：Input / Select / Textarea / Field
 *
 - 统一 label + 错误提示
 - focus ring 键盘可见
 - 触达 ≥40px（输入框高 40px + padding）
 */
import type React from 'react';

export interface FieldProps {
  label?: React.ReactNode;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, error, hint, required, children, className }: FieldProps): React.ReactElement {
  return (
    <div className={`mu-field ${error ? 'has-error' : ''} ${className ?? ''}`}>
      {label && (
        <label className="mu-field-label">
          {label}
          {required && <span className="mu-field-required" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <div className="mu-field-hint">{hint}</div>}
      {error && <div className="mu-field-error" role="alert">{error}</div>}
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
