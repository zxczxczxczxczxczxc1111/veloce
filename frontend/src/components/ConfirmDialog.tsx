import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { Button } from "./ui/Button";

type Props = {
  /** Заголовок с ИМЕНЕМ проекта, а не «Вы уверены?». */
  title: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Разница между «Вы уверены?» и «Перезапустить demo-worker?» это разница
// между «нажал не глядя» и «прочитал». Поэтому имя проекта в заголовок кладёт
// вызывающий, а собственного текста у диалога нет вовсе.
export function ConfirmDialog({
  title,
  detail,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Фокус уезжает на ОТМЕНУ, а не на подтверждение: пробел или Enter по
  // привычке не должны перезапускать чужой прод.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      // Клик по подложке закрывает: это отмена, а отмену надо делать лёгкой.
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-full rounded-xl border border-border bg-elevated p-5 shadow-card"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        {detail !== undefined && (
          <p className="mt-2 text-sm text-fg-secondary">{detail}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            {t.projects.cancel}
          </Button>
          <Button variant={danger ? "danger" : "accent"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
