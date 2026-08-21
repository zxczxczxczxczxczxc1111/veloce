import { useState } from "react";
import { ProjectsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { useFormat } from "../format";
import { useT } from "../i18n";
import { useRestart } from "../state/actions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";

// Сколько держать след падения. Пять минут это про «отошёл за кофе»:
// дольше метка превращается в шум, короче - бесполезна.
const TRACE_MS = 5 * 60_000;

type Props = {
  serverId: string;
  project: ProjectDTO;
  /** Когда проект последний раз видели лежащим, мс. 0 - не видели. */
  downAt: number;
  /** Перечитать список после сохранения настройки. */
  onChanged: () => void;
  /** Открыть экран проекта. */
  onOpen: (p: ProjectDTO) => void;
};

export function ProjectRow({ serverId, project, downAt, onChanged, onOpen }: Props) {
  const t = useT();
  const f = useFormat();
  // След показываем только у поднявшегося: у лежащего и так написано «Лежит»,
  // и вторая метка про то же самое была бы шумом.
  const trace =
    project.state !== "down" && downAt > 0 && Date.now() - downAt < TRACE_MS;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const restart = useRestart(serverId, project);

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-4 px-5 py-2.5">
        <StatusDot state={project.state} />

        <button
          onClick={() => onOpen(project)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block truncate text-sm hover:text-accent">
            {project.name}
          </span>
          <span className="block truncate text-xs text-fg-muted">
            {project.kind} · {detail(t, project)}
            {trace && (
              <span className="ml-2 text-accent">
                {t.fmt(t.projects.recentlyDown, { ago: f.ago(downAt) })}
              </span>
            )}
          </span>
        </button>

        {/* Потребление в колонках: моноширинные цифры не дают строкам скакать
            на каждом такте. */}
        {/* Прочерк ставится по флагу «значения нет», а не по нулю: у
            простаивающего контейнера 0.00% это честный ответ, и подменять его
            прочерком значит говорить «не знаю» там, где мы знаем. */}
        <span className="num w-24 shrink-0 text-right text-sm text-fg-secondary">
          {project.cpuKnown ? f.percent(project.cpuPercent) : "-"}
        </span>
        <span className="num w-24 shrink-0 text-right text-sm text-fg-secondary">
          {project.memKnown ? f.bytes(project.memBytes) : "-"}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <Button dense disabled={restart.pending} onClick={() => setConfirm(true)}>
            {restart.pending ? t.projects.restarting : t.projects.restart}
          </Button>
          <Button dense variant="ghost" onClick={() => setOpen((v) => !v)}>
            {t.projects.settings}
          </Button>
        </span>
      </div>

      <RestartOutcome restart={restart} name={project.name} />

      {open && (
        <ProjectSettings
          serverId={serverId}
          project={project}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={t.fmt(t.projects.confirmRestart, { name: project.name })}
          detail={t.projects.confirmRestartDetail}
          confirmLabel={t.projects.restart}
          onConfirm={() => {
            setConfirm(false);
            restart.run();
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </li>
  );
}

// RestartOutcome показывает, чем кончился перезапуск. Молчаливая кнопка это
// худший вариант: человек не знает, поднялся проект или нет, и жмёт ещё раз.
export function RestartOutcome({
  restart,
  name,
}: {
  restart: ReturnType<typeof useRestart>;
  name: string;
}) {
  const t = useT();
  if (restart.error === null && !restart.failed) return null;

  return (
    <div className="border-t border-border bg-elevated px-5 py-3">
      {restart.error !== null && <p className="text-sm text-down">{restart.error}</p>}
      {restart.failed && (
        <>
          <p className="text-sm text-down">{t.fmt(t.errors.actionFailed, { name })}</p>
          {restart.lines.length > 0 && (
            <pre className="num mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-fill-subtle p-3 font-mono text-xs text-fg-secondary">
              {restart.lines.join("\n")}
            </pre>
          )}
        </>
      )}
      <Button dense variant="ghost" className="mt-2" onClick={restart.dismiss}>
        {t.projects.dismiss}
      </Button>
    </div>
  );
}

// detail дописывает к строке состояния то, ЧЕГО ждёт юнит. «Ждёт» без ответа
// на вопрос «чего» это загадка, а не сообщение.
export function detail(t: ReturnType<typeof useT>, p: ProjectDTO): string {
  if (p.state !== "waiting" || p.trigger === "") return p.status;
  const tpl = p.trigger.endsWith(".socket") ? t.projects.bySocket : t.projects.byTimer;
  return t.fmt(tpl, { name: p.trigger });
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

// Состояние никогда не передаётся ОДНИМ цветом: рядом всегда есть слово.
// Зелёное и красное неразличимы у части читателей, а точка без подписи в такой
// панели это единственный носитель самого важного факта.
//
// Зелёный означает «есть живой процесс прямо сейчас», и только это. Юнит,
// который отработал и завершился, серый: он сделал дело, но не крутится, и
// зелёный на нём был бы неправдой.
export function StatusDot({ state }: { state: string }) {
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
