import { Events as WailsEvents } from "@wailsio/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EventsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { Incident } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ContentState } from "../components/ui/ContentState";
import { useFormat } from "../format";
import { useT } from "../i18n";

type Props = {
  serverId: string;
  onBack: () => void;
};

type Filter = "all" | "critical" | "warning" | "info";

export function EventsScreen({ serverId, onBack }: Props) {
  const t = useT();
  const f = useFormat();
  const [list, setList] = useState<Incident[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setList((await EventsService.List(serverId)) ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setList([]);
    }
  }, [serverId]);

  useEffect(() => {
    void reload();
    // Открытый экран считается прочитанным: счётчик непрочитанного нужен,
    // чтобы позвать сюда, а не чтобы висеть, пока человек уже смотрит.
    void EventsService.MarkRead(serverId).catch(() => {});
    const off = WailsEvents.On("events:new", (e: { data: { serverId: string } }) => {
      if (e.data.serverId !== serverId) return;
      void reload();
      void EventsService.MarkRead(serverId).catch(() => {});
    });
    return () => {
      off();
    };
  }, [serverId, reload]);

  const shown = useMemo(() => {
    const all = list ?? [];
    return filter === "all" ? all : all.filter((e) => e.severity === filter);
  }, [list, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button dense variant="ghost" onClick={onBack}>
          {t.project.back}
        </Button>
        <span className="text-sm font-semibold">{t.events.title}</span>
        <span className="num text-xs text-fg-muted">
          {t.fmt(t.events.counter, { n: String((list ?? []).length) })}
        </span>
      </div>

      <Card
        className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0 [&>div]:flex-1 [&>div]:overflow-y-auto [&>div]:p-0"
        title={t.events.title}
        actions={
          <div className="flex items-center gap-1">
            {(["all", "critical", "warning", "info"] as const).map((v) => (
              <Button
                key={v}
                dense
                variant={filter === v ? "secondary" : "ghost"}
                onClick={() => setFilter(v)}
              >
                {t.events.filters[v]}
              </Button>
            ))}
          </div>
        }
      >
        <ContentState
          pending={list === null}
          fetching={false}
          skeleton={<div className="h-24 bg-fill-subtle" />}
        >
          {error !== null && <p className="px-5 py-3 text-sm text-down">{error}</p>}
          {shown.length === 0 ? (
            // Пустая лента это ХОРОШАЯ новость, и говорить об этом надо прямо,
            // а не показывать пустоту, неотличимую от поломки.
            <p className="px-5 py-6 text-sm text-fg-muted">{t.events.empty}</p>
          ) : (
            <ul>
              {shown.map((e, i) => (
                <li
                  key={e.at + ":" + e.title + ":" + i}
                  className="flex items-start gap-4 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <SeverityMark severity={e.severity} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{e.title}</span>
                    <span className="block truncate text-xs text-fg-muted">
                      {e.source} · {e.detail}
                    </span>
                  </span>
                  <span className="num shrink-0 text-xs text-fg-muted">
                    {t.fmt(t.events.ago, { ago: f.ago(e.at) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ContentState>
      </Card>
    </div>
  );
}

// Важность идёт словом, а не только цветом: красный и янтарный неразличимы у
// части читателей, а в ленте событий важность это главное.
function SeverityMark({ severity }: { severity: string }) {
  const t = useT();
  const map: Record<string, { cls: string; label: string }> = {
    critical: { cls: "bg-down", label: t.events.filters.critical },
    warning: { cls: "bg-accent", label: t.events.filters.warning },
    info: { cls: "bg-fg-faint", label: t.events.filters.info },
  };
  const v = map[severity] ?? map.info;
  return (
    <span className="flex w-24 shrink-0 items-center gap-2 pt-0.5">
      <span className={"inline-block h-2 w-2 rounded-full " + v.cls} />
      <span className="text-xs text-fg-muted">{v.label}</span>
    </span>
  );
}
