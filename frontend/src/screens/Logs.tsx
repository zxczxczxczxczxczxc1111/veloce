import type { ProjectDTO } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { LogView } from "../components/LogView";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useT } from "../i18n";
import { useProjectTick } from "../state/projects";

type Props = {
  serverId: string;
  /** Снимок на момент открытия: дальше обновляется общим тактом. */
  project: ProjectDTO;
  onBack: () => void;
};

// Полноэкранный поток. Отдельный экран нужен потому, что в карточке проекта
// видно строк двадцать, а разбор происшествия начинается с прокрутки на
// несколько сотен.
export function Logs({ serverId, project, onBack }: Props) {
  const t = useT();
  const current = useProjectTick(serverId, project);
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button dense variant="ghost" onClick={onBack}>
          {t.project.back}
        </Button>
        <span className="truncate text-sm font-semibold">{current.name}</span>
        <span className="truncate text-xs text-fg-muted">{t.logs.title}</span>
      </div>

      <Card
        className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0 [&>div]:flex-1 [&>div]:p-0"
      >
        <LogView
          serverId={serverId}
          projectId={current.id}
          kind={current.kind}
          live={current.state === "running"}
          className="h-full"
        />
      </Card>
    </div>
  );
}
