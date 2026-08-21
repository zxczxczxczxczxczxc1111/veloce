import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectsTick } from "../state/events";
import { MetricTile, Meter } from "../components/MetricTile";
import { TickAge } from "../components/TickAge";
import { ProjectRow } from "../components/ProjectRow";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ContentState } from "../components/ui/ContentState";
import { useFormat } from "../format";
import { useT } from "../i18n";
import type { ConnState } from "../state/conn";
import { percent, useMetrics } from "../state/metrics";

type Props = {
  serverId: string;
  state: ConnState;
  onConnect: () => void;
  /** Уйти в настройку подключения: ключ переподключением не лечится. */
  onFixConnection: () => void;
  /** Открыть экран проекта. */
  onOpenProject: (p: ProjectDTO) => void;
};

export function Overview({
  serverId,
  state,
  onConnect,
  onFixConnection,
  onOpenProject,
}: Props) {
  const t = useT();
  const f = useFormat();
  const history = useMetrics(serverId);
  const last = history.last;
  const missing = last?.missing ?? [];

  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setProjects((await ProjectsService.Discover(serverId)) ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setProjects([]);
    }
  }, [serverId]);

  // Первый список запрашиваем сами: такт проектов идёт раз в пять секунд, и
  // без этого экран пять секунд стоял бы пустым после подключения.
  useEffect(() => {
    if (state.kind !== "connected") return;
    void reload();
  }, [state.kind, reload]);

  useEffect(() => {
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (e.data.serverId !== serverId) return;
      setProjects(e.data.projects ?? []);
    });
    return () => {
      off();
    };
  }, [serverId]);

  // Память о падениях: снимок такта её не содержит, а человек, отошедший на
  // пять минут, обязан узнать, что проект успел упасть и подняться.
  const downSince = useRef(new Map<string, number>());
  useEffect(() => {
    const now = Date.now();
    for (const p of projects ?? []) {
      const key = p.kind + ":" + p.id;
      if (p.state === "down") downSince.current.set(key, now);
    }
  }, [projects]);

  const shown = useMemo(() => {
    const list = (projects ?? []).filter((p) => showHidden || !p.hidden);
    // Проблемные наверх. На двух сотнях проектов это единственный способ
    // увидеть беду, не листая: сортировка устойчивая, поэтому внутри группы
    // порядок остаётся прежним и строки не прыгают на каждом такте.
    return list
      .map((p, i) => ({ p, i }))
      .sort((a, b) => rank(a.p.state) - rank(b.p.state) || a.i - b.i)
      .map((x) => x.p);
  }, [projects, showHidden]);

  const hiddenCount = (projects ?? []).filter((p) => p.hidden).length;
  const downCount = (projects ?? []).filter(
    (p) => !p.hidden && p.state === "down",
  ).length;

  // Ключ не принят это ОТДЕЛЬНЫЙ случай, а не «нет связи»: переподключение
  // бессмысленно, ключ не станет верным от повторной попытки, и кнопка
  // «подключиться» здесь только злит. Отправляем туда, где это чинится.
  if (state.kind === "authFailed" || state.kind === "hostKeyUnknown" ||
      state.kind === "hostKeyChanged") {
    return (
      <Card
        title={
          state.kind === "authFailed" ? t.errors.authFailed : t.servers.hostKeyUnknown
        }
      >
        <Button variant="accent" onClick={onFixConnection}>
          {t.errors.fixConnection}
        </Button>
      </Card>
    );
  }

  if (state.kind !== "connected" && last === null) {
    // Пустой экран с плитками-прочерками врал бы: сервер не «показывает
    // ноль», с ним просто нет связи.
    return (
      <Card title={t.overview.notConnected}>
        <Button variant="accent" onClick={onConnect}>
          {t.overview.connect}
        </Button>
      </Card>
    );
  }

  // Цифры на экране есть, но связи нет: они ЗАМЕРЛИ. Это самый опасный вид
  // отказа, потому что выглядит он как работающая панель. Шапка приглушается,
  // и рядом стоит время последнего успешного замера.
  const frozen =
    state.kind === "degraded" || state.kind === "disconnected" || state.kind === "connecting";
  const frozenAt =
    state.kind === "degraded" && state.lastOkAt > 0 ? state.lastOkAt : null;

  const memPercent = last === null ? 0 : percent(last.memUsed, last.memTotal);
  const disk = last?.disks?.[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
          {t.overview.uptime}
        </span>
        <span className="num text-sm">
          {last === null || missing.includes("uptime")
            ? t.overview.waiting
            : f.uptime(last.uptimeSec)}
        </span>

        {/* Возраст данных стоит ВСЕГДА, а не только при отказе: увидеть, что
            цифры перестали двигаться, человек должен раньше, чем это заметит
            транспорт. */}
        <TickAge at={history.lastAt} />

        {frozen && (
          <span className="num text-sm text-accent">
            {frozenAt !== null
              ? t.fmt(t.errors.frozen, {
                  time: new Date(frozenAt).toLocaleTimeString(),
                })
              : t.errors.reconnecting}
          </span>
        )}
      </div>

      {/* Четыре плитки в ряд: на 1920 и 2560 они помещаются целиком, и весь
          ответ «всё ли живо» читается одним движением глаз слева направо.
          При замерших данных они приглушаются: живые и мёртвые цифры обязаны
          выглядеть по-разному, иначе панель врёт молча. */}
      <div
        className="grid grid-cols-4 gap-4 transition-opacity"
        style={{ opacity: frozen ? 0.45 : 1 }}
      >
        <MetricTile
          label={t.overview.cpu}
          value={
            last === null || missing.includes("cpu") ? null : f.percent(last.cpuPercent)
          }
          points={history.cpu}
          // Ось процентов фиксированная. Плавающая рисует панику на спокойном
          // сервере: шум в полпроцента растягивается на всю высоту плитки.
          max={100}
        />

        <MetricTile
          label={t.overview.memory}
          value={
            last === null || missing.includes("memory") ? null : f.percent(memPercent)
          }
          note={
            last === null
              ? undefined
              : f.bytes(last.memUsed) + " / " + f.bytes(last.memTotal)
          }
          points={history.memPercent}
          max={100}
        />

        <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
          <div className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
            {t.overview.disk}
          </div>
          {/* У диска истории нет: это уровень, а не поток. Полоса заполнения
              честнее спарклайна, который за пять минут нарисовал бы прямую. */}
          <div className="mt-1.5 flex items-baseline gap-2">
            <span
              className={
                "num text-[26px] font-semibold leading-none " +
                (disk === undefined ? "text-fg-faint" : "text-foreground")
              }
            >
              {disk === undefined ? "-" : f.percent(percent(disk.used, disk.size))}
            </span>
            {disk !== undefined && (
              <span className="num text-xs text-fg-muted">
                {f.bytes(disk.used)} / {f.bytes(disk.size)}
              </span>
            )}
          </div>
          <div className="mt-3 h-10 flex flex-col justify-center">
            {disk !== undefined && <Meter percent={percent(disk.used, disk.size)} />}
            {disk !== undefined && (
              <div className="num mt-2 truncate text-xs text-fg-muted">{disk.mount}</div>
            )}
          </div>
        </div>

        <MetricTile
          label={t.overview.network}
          value={last === null || missing.includes("net") ? null : f.rate(last.rxPerSec)}
          note={last === null ? undefined : "TX " + f.rate(last.txPerSec)}
          points={history.rx}
          // У трафика естественного потолка нет, ось плавающая по окну.
          max={null}
        />
      </div>

      <Card
        title={t.projects.title}
        actions={
          <>
            {/* Счётчик виден, даже когда список прокручен: беда не должна
                зависеть от того, докрутил ли человек до нужной строки. */}
            {downCount > 0 && (
              <span className="num text-xs text-down">
                {t.fmt(t.projects.downCount, { n: String(downCount) })}
              </span>
            )}
            {hiddenCount > 0 && (
              <span className="num text-xs text-fg-muted">
                {t.fmt(t.projects.hiddenCount, { n: String(hiddenCount) })}
              </span>
            )}
            <Button dense variant="ghost" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? t.projects.hideAll : t.projects.showAll}
            </Button>
          </>
        }
        className="[&>div]:p-0"
      >
        <ContentState
          pending={projects === null}
          fetching={false}
          skeleton={<div className="h-24 bg-fill-subtle" />}
        >
          {error !== null && <p className="px-5 py-3 text-sm text-down">{error}</p>}
          {shown.length === 0 ? (
            <p className="px-5 py-6 text-sm text-fg-muted">{t.projects.empty}</p>
          ) : (
            <ul>
              {shown.map((p) => (
                <ProjectRow
                  key={p.kind + ":" + p.id}
                  serverId={serverId}
                  project={p}
                  downAt={downSince.current.get(p.kind + ":" + p.id) ?? 0}
                  onChanged={() => void reload()}
                  onOpen={onOpenProject}
                />
              ))}
            </ul>
          )}
        </ContentState>
      </Card>
    </div>
  );
}

// rank задаёт порядок групп: сперва то, что требует внимания.
function rank(state: string): number {
  if (state === "down") return 0;
  if (state === "starting") return 1;
  return 2;
}
