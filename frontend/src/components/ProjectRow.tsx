import { useState } from "react";
import { ProjectsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { ProjectKind } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/collect";
import { useFormat } from "../format";
import { useT } from "../i18n";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";

type Props = {
  serverId: string;
  project: ProjectDTO;
  /** Перечитать список после сохранения настройки. */
  onChanged: () => void;
};

export function ProjectRow({ serverId, project, onChanged }: Props) {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function restart() {
    setBusy(true);
    setError(null);
    try {
      // Вид проекта в DTO это строка, а биндинг Action ждёт перечисление.
      // Приводим ЯВНО через сравнение, а не кастом: неизвестное значение
      // должно упереться здесь, а не улететь в подстановку команды на сервере.
      const kind =
        project.kind === "docker" ? ProjectKind.KindDocker : ProjectKind.KindSystemd;
      await ProjectsService.Action(serverId, project.id, kind, "restart");
      setConfirm(false);
    } catch (e: unknown) {
      // Ошибка живёт в карточке проекта, остальной экран продолжает работать:
      // недоступный docker не повод гасить всю панель.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-4 px-5 py-2.5">
        <StatusDot state={project.state} />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{project.name}</span>
          <span className="block truncate text-xs text-fg-muted">
            {project.kind} · {detail(t, project)}
          </span>
        </span>

        {/* Потребление в колонках: моноширинные цифры не дают строкам скакать
            на каждом такте. */}
        <span className="num w-24 shrink-0 text-right text-sm text-fg-secondary">
          {project.cpuPercent > 0 ? f.percent(project.cpuPercent) : "-"}
        </span>
        <span className="num w-24 shrink-0 text-right text-sm text-fg-secondary">
          {project.memBytes > 0 ? f.bytes(project.memBytes) : "-"}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {confirm ? (
            <>
              <Button dense variant="danger" disabled={busy} onClick={() => void restart()}>
                {t.fmt(t.projects.confirmRestart, { name: project.name })}
              </Button>
              <Button dense variant="ghost" onClick={() => setConfirm(false)}>
                {t.projects.cancel}
              </Button>
            </>
          ) : (
            <Button dense onClick={() => setConfirm(true)}>
              {t.projects.restart}
            </Button>
          )}
          <Button dense variant="ghost" onClick={() => setOpen((v) => !v)}>
            {t.projects.settings}
          </Button>
        </span>
      </div>

      {error !== null && (
        <p className="px-5 pb-2.5 text-sm text-down">{error}</p>
      )}

      {open && (
        <ProjectSettings
          serverId={serverId}
          project={project}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  );
}

// Настройка живёт ВНУТРИ карточки проекта. Отдельный экран ради трёх полей
// заводить не надо: пользователь и так смотрит на нужную строку.
function ProjectSettings({
  serverId,
  project,
  onClose,
  onChanged,
}: {
  serverId: string;
  project: ProjectDTO;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [label, setLabel] = useState(project.name);
  const [hidden, setHidden] = useState(project.hidden);
  const [health, setHealth] = useState(project.health);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await ProjectsService.SaveOverride({
        serverId,
        kind: project.kind,
        id: project.id,
        // Имя, совпадающее с обнаруженным, не сохраняем как подмену: иначе
        // переименование на сервере больше никогда не доедет до экрана.
        label: label === project.name ? "" : label.trim(),
        hidden,
        health: health.trim(),
      });
      onChanged();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="border-t border-border bg-elevated px-5 py-4">
      <div className="grid grid-cols-2 gap-4">
        <Field
          label={t.projects.label}
          hint={t.projects.labelHint}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Field
          label={t.projects.health}
          hint={t.projects.healthHint}
          placeholder="http://127.0.0.1:8080/health"
          value={health}
          onChange={(e) => setHealth(e.target.value)}
        />
      </div>

      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-fg-secondary">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => setHidden(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
        />
        {t.projects.hide}
      </label>

      {error !== null && <p className="mt-3 text-sm text-down">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Button dense variant="accent" onClick={() => void save()}>
          {t.projects.save}
        </Button>
        <Button dense variant="ghost" onClick={onClose}>
          {t.projects.cancel}
        </Button>
      </div>
    </div>
  );
}

// detail дописывает к строке состояния то, ЧЕГО ждёт юнит. «Ждёт» без ответа
// на вопрос «чего» это загадка, а не сообщение.
function detail(t: ReturnType<typeof useT>, p: ProjectDTO): string {
  if (p.state !== "waiting" || p.trigger === "") return p.status;
  const tpl = p.trigger.endsWith(".socket") ? t.projects.bySocket : t.projects.byTimer;
  return t.fmt(tpl, { name: p.trigger });
}

// Состояние никогда не передаётся ОДНИМ цветом: рядом всегда есть слово.
// Зелёное и красное неразличимы у части читателей, а точка без подписи в такой
// панели это единственный носитель самого важного факта.
//
// Зелёный означает «есть живой процесс прямо сейчас», и только это. Юнит,
// который отработал и завершился, серый: он сделал дело, но не крутится, и
// зелёный на нём был бы неправдой.
function StatusDot({ state }: { state: string }) {
  const t = useT();
  const map: Record<string, { cls: string; label: string }> = {
    running: { cls: "bg-up", label: t.projects.running },
    done: { cls: "bg-fg-faint", label: t.projects.done },
    waiting: { cls: "bg-fg-faint", label: t.projects.waiting },
    starting: { cls: "bg-accent motion-safe:animate-pulse", label: t.projects.starting },
    down: { cls: "bg-down", label: t.projects.stopped },
  };
  // Незнакомое значение с той стороны не красим ни зелёным, ни красным: оба
  // были бы утверждением, которого мы не делали.
  const v = map[state] ?? { cls: "bg-fg-faint", label: t.projects.unknown };
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className={"inline-block h-2 w-2 rounded-full " + v.cls} />
      <span className="w-24 text-xs text-fg-muted">{v.label}</span>
    </span>
  );
}
