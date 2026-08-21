import { useMemo, useState } from "react";
import { useLang, useSetLang, useT } from "../../i18n";
import type { Server } from "../../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";

type Props = {
  servers: Server[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
};

// Ширина рейки фиксированная, содержимое справа тянется. Раскладка рассчитана
// на 1920 и 2560, мобильной не предусмотрено.
export function ServerRail({ servers, activeId, onSelect, onAdd }: Props) {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return servers;
    // Ищем и по метке, и по хосту, и по тегам: на два десятка серверов
    // выбирать глазами уже дольше, чем набрать три буквы.
    return servers.filter((s) => {
      const hay = [s.label, s.host, ...(s.tags ?? [])].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [servers, query]);

  return (
    <nav className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-rail">
      <div className="flex h-[52px] items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold">{t.servers.title}</span>
        <button
          onClick={onAdd}
          title={t.servers.add}
          aria-label={t.servers.add}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-fill hover:text-foreground"
        >
          +
        </button>
      </div>

      <div className="p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.servers.filter}
          aria-label={t.servers.filter}
          className="h-8 w-full rounded-lg border border-border bg-fill-subtle px-3 text-sm text-foreground placeholder:text-fg-muted transition-colors hover:border-border-hover"
        />
      </div>

      <ul className="flex-1 overflow-y-auto px-2 pb-2">
        {shown.length === 0 && (
          <li className="px-2 py-6 text-center text-xs text-fg-muted">
            {t.servers.empty}
          </li>
        )}
        {shown.map((s) => {
          const active = s.id === activeId;
          return (
            <li key={s.id}>
              <button
                onClick={() => onSelect(s.id)}
                aria-current={active}
                className={
                  "mb-1 flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors " +
                  (active
                    ? "bg-surface-active text-foreground"
                    : "text-fg-secondary hover:bg-surface-hover hover:text-foreground")
                }
              >
                <span className="w-full truncate text-sm">
                  {s.label !== "" ? s.label : s.host}
                </span>
                <span className="w-full truncate text-xs text-fg-muted">
                  {s.user !== "" ? s.user + "@" : ""}
                  {s.host}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Отдельного экрана настроек ради одного поля не заводим. */}
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
          {t.app.language}
        </span>
        <div className="flex items-center gap-1">
          {(["ru", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              aria-pressed={lang === l}
              className={
                "h-7 cursor-pointer rounded-md px-2 text-xs uppercase transition-colors " +
                (lang === l
                  ? "bg-fill text-foreground"
                  : "text-fg-muted hover:bg-fill hover:text-foreground")
              }
            >
              {l}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
