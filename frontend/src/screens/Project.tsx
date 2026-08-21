import { useCallback, useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import { ProjectsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type {
  HealthResult,
  ProjectDTO,
} from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectsTick } from "../state/events";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LogView } from "../components/LogView";
import { RestartOutcome, StatusDot, detail } from "../components/ProjectRow";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useFormat } from "../format";
import { useT } from "../i18n";
import { useRestart } from "../state/actions";
import { useHealth } from "../state/health";
import { kindOf } from "../state/logs";

type Props = {
  serverId: string;
  /** Снимок на момент открытия: дальше обновляется тактом. */
  project: ProjectDTO;
  onBack: () => void;
  onFullLogs: () => void;
};

export function Project({ serverId, project, onBack, onFullLogs }: Props) {
  const t = useT();
  const f = useFormat();
  const [current, setCurrent] = useState(project);
  const [restarts, setRestarts] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const restart = useRestart(serverId, current);
  // Проверка идёт только у работающего проекта: стучаться в адрес
  // остановленного значит каждые пятнадцать секунд получать ожидаемый отказ и
  // красить карточку красным без новостей.
  const health = useHealth(serverId, current.health, current.state === "running");

  // Карточка живёт с общего такта проектов, своего опроса не заводит: два
  // источника одних и тех же цифр разъедутся на глазах у человека.
  useEffect(() => {
    const off = Events.On("projects:tick", (e: { data: ProjectsTick }) => {
      if (e.data.serverId !== serverId) return;
      const fresh = (e.data.projects ?? []).find(
        (p) => p.kind === project.kind && p.id === project.id,
      );
      if (fresh !== undefined) setCurrent(fresh);
    });
    return () => {
      off();
    };
  }, [serverId, project.kind, project.id]);

  const loadRestarts = useCallback(async () => {
    try {
      setRestarts(await ProjectsService.Restarts(serverId, project.id, kindOf(project.kind)));
    } catch {
      // Число перезапусков это справка, а не основа экрана. Молчим и рисуем
      // прочерк: гасить карточку из-за него нельзя.
      setRestarts(null);
    }
  }, [serverId, project.id, project.kind]);

  useEffect(() => {
    void loadRestarts();
  }, [loadRestarts]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button dense variant="ghost" onClick={onBack}>
          {t.project.back}
        </Button>
        <StatusDot state={current.state} />
        <span className="truncate text-sm font-semibold">{current.name}</span>
        <span className="truncate text-xs text-fg-muted">
          {current.kind} · {detail(t, current)}
        </span>
      </div>

      <Card
        title={t.project.title}
        actions={
          <Button
            dense
            disabled={restart.pending}
            onClick={() => setConfirm(true)}
          >
            {restart.pending ? t.projects.restarting : t.projects.restart}
          </Button>
        }
        className="[&>div]:p-0"
      >
        <div className="grid grid-cols-4 gap-px bg-border">
          {/* Ноль это значение, прочерк это отсутствие значения. Решает
              флаг с той стороны, а не сравнение с нулём. */}
          <Big
            label={t.projects.cpu}
            value={current.cpuKnown ? f.percent(current.cpuPercent) : "-"}
          />
          <Big
            label={t.projects.memory}
            value={current.memKnown ? f.bytes(current.memBytes) : "-"}
          />
          <Big
            label={t.project.restarts}
            // -1 значит «у контейнеров такого счётчика нет», а не ноль.
            // Ноль здесь читался бы как «ни разу не падал», это разные вещи.
            value={restarts === null || restarts < 0 ? "-" : String(restarts)}
            // Подпись только там, где есть число. Под прочерком «с последнего
            // запуска» читается как пояснение к пустоте.
            note={
              restarts !== null && restarts >= 0 ? t.project.restartsNote : undefined
            }
          />
          <HealthTile health={health} url={current.health} />
        </div>

        <RestartOutcome restart={restart} name={current.name} />
      </Card>

      <Card
        title={t.logs.title}
        actions={
          <Button dense variant="ghost" onClick={onFullLogs}>
            {t.project.fullLogs}
          </Button>
        }
        className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0 [&>div]:flex-1 [&>div]:p-0"
      >
        <LogView
          serverId={serverId}
          projectId={current.id}
          kind={current.kind}
          className="h-full"
        />
      </Card>

      {confirm && (
        <ConfirmDialog
          title={t.fmt(t.projects.confirmRestart, { name: current.name })}
          detail={t.projects.confirmRestartDetail}
          confirmLabel={t.projects.restart}
          onConfirm={() => {
            setConfirm(false);
            restart.run();
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function Big({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="bg-surface p-5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
        {label}
      </div>
      <div className="num mt-1.5 text-[26px] font-semibold leading-none">{value}</div>
      {note !== undefined && (
        <div className="mt-1.5 text-xs text-fg-muted">{note}</div>
      )}
    </div>
  );
}

// HealthTile отвечает на вопрос, который статус контейнера не покрывает:
// «процесс запущен» и «приложение работает» это разные утверждения, контейнер
// бывает up и мёртв внутри.
function HealthTile({
  health,
  url,
}: {
  health: HealthResult | null;
  url: string;
}) {
  const t = useT();
  const f = useFormat();

  if (health === null || !health.configured) {
    // Отсутствие проверки это не отказ: у большинства проектов health-check не
    // настроен, и красное на них было бы враньём.
    //
    // Настроенная, но не идущая проверка это ТРЕТИЙ случай: у остановленного
    // проекта стучаться некуда. Написать ему «не настроен» значит соврать про
    // настройку, которую человек сделал своими руками.
    const note = url.trim() === "" ? t.health.none : t.health.paused;
    return (
      <div className="bg-surface p-5">
        <div className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
          {t.health.title}
        </div>
        <div className="mt-1.5 text-[26px] font-semibold leading-none text-fg-faint">
          -
        </div>
        <div className="mt-1.5 text-xs text-fg-muted">{note}</div>
      </div>
    );
  }

  return (
    <div className="bg-surface p-5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-muted">
        {t.health.title}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className={
            "text-[26px] font-semibold leading-none " +
            (health.ok ? "text-up" : "text-down")
          }
        >
          {health.ok ? t.health.ok : t.health.failed}
        </span>
        <span className="num text-xs text-fg-muted">
          {/* Код 000 это не ответ сервера, а его отсутствие: так curl
              сообщает про таймаут и отказ соединения. */}
          {health.code === 0
            ? t.health.noAnswer
            : t.fmt(t.health.code, { code: String(health.code) })}
        </span>
      </div>
      {/* Время ПОСЛЕДНЕГО УСПЕШНОГО ответа, а не последней проверки:
          «проверено 5 секунд назад» у лежащего сервиса бесполезно. */}
      <div className="mt-1.5 text-xs text-fg-muted">
        {health.lastOkAt === 0
          ? t.health.neverOk
          : t.fmt(t.health.lastOk, { ago: f.ago(health.lastOkAt) })}
      </div>
    </div>
  );
}
