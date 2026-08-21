import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";

type Props = {
  label: string;
  /** Готовая строка значения. null - метрику не удалось прочитать. */
  value: string | null;
  /** Мелкая приписка справа от значения: доля, единицы, второе число. */
  note?: ReactNode;
  points?: number[];
  /** Верх шкалы спарклайна. null - плавающая ось. */
  max?: number | null;
};

// Плитка отвечает на вопрос «сколько сейчас», спарклайн под ней - на вопрос
// «куда движется». Порядок именно такой: число крупное сверху, линия мелкая
// снизу. Наоборот читается как график с подписью, и глазу приходится искать
// текущее значение.
export function MetricTile({ label, value, note, points, max = null }: Props) {
  const missing = value === null;
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
        {label}
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        {/* num здесь намеренно: значение обновляется каждые две секунды, и
            пропорциональные цифры дёргали бы плитку на каждом такте, потому
            что «11» уже, чем «00». */}
        <span
          className={
            "num text-[26px] font-semibold leading-none " +
            (missing ? "text-fg-faint" : "text-foreground")
          }
        >
          {/* Прочерк, а не ноль. «Нагрузки нет» и «не смогли прочитать» это
              противоположные утверждения, и путать их нельзя. */}
          {value ?? "-"}
        </span>
        {note !== undefined && !missing && (
          <span className="num text-xs text-fg-muted">{note}</span>
        )}
      </div>

      <div className="mt-3">
        {/* У не прочитанной метрики линия не дорисовывается: последняя точка
            осталась бы висеть как «всё по-прежнему». */}
        {points !== undefined && !missing ? (
          <Sparkline points={points} max={max} label={label} />
        ) : (
          <div className="h-10" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// Meter - уровень без истории: занято из общего. Заполнение несёт тяжесть,
// дорожка это тот же цвет тише, чтобы состояние читалось по всей полосе.
export function Meter({ percent }: { percent: number }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-fill">
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: clamped.toFixed(1) + "%" }}
      />
    </div>
  );
}
