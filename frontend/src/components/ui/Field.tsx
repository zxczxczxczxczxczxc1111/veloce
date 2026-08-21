import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  /** Подсказка или текст ошибки под полем. */
  hint?: ReactNode;
  invalid?: boolean;
};

// Метка связана с полем через id, а не обёрнута вокруг: обёртка ломает клик по
// подписи в webview и не читается экранным диктором как метка.
export function Field({
  label,
  hint,
  invalid = false,
  className = "",
  ...rest
}: Props) {
  const id = useId();
  return (
    <div className={"flex flex-col gap-1.5 " + className}>
      <label
        htmlFor={id}
        className="text-[10px] uppercase tracking-[0.08em] text-fg-muted"
      >
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid}
        className={
          "h-9 rounded-lg bg-fill-subtle px-3 text-sm text-foreground " +
          "placeholder:text-fg-muted transition-colors " +
          "border " +
          (invalid ? "border-down/50" : "border-border hover:border-border-hover")
        }
        {...rest}
      />
      {hint !== undefined && (
        <span
          className={
            "text-xs " + (invalid ? "text-down" : "text-fg-secondary")
          }
        >
          {hint}
        </span>
      )}
    </div>
  );
}
