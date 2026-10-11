import {
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import { X, LoaderCircle } from "lucide-react";

export function Button({
  children,
  onClick,
  disabled = false,
  busy = false,
  primary = false,
  label,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`button ${primary ? "primary" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <Button label="关闭窗口" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function Input({
  label,
  error,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
}) {
  const generated = useId();
  const id = props.id || generated;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-invalid={!!error}
        aria-describedby={error || hint ? `${id}-help` : undefined}
      />
      {(error || hint) && (
        <small id={`${id}-help`} className={error ? "error-text" : ""}>
          {error || hint}
        </small>
      )}
    </div>
  );
}
export function Field({
  id,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={`${id}-help`}
      />
      <small id={`${id}-help`} className={error ? "error-text" : ""}>
        {error || hint}
      </small>
    </div>
  );
}
