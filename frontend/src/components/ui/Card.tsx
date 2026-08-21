import type { ReactNode } from "react";

type Props = {
  /** Шапка карточки. Без неё карточка это просто тело с отступом p-5. */
  title?: ReactNode;
  /** Действия в правой части шапки: кнопки берут dense или h-8. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
};

// Отступы из правил admpanel: шапка px-5 py-3.5, тело p-5. Обе пары в шаг 4px
// не укладываются и это названное исключение, а не недосмотр.
export function Card({ title, actions, className = "", children }: Props) {
  return (
    <section
      className={
        "rounded-xl border border-border bg-surface shadow-card " + className
      }
    >
      {title !== undefined && (
        <header className="flex h-[52px] items-center justify-between gap-4 border-b border-border px-5">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {title}
          </h2>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}
