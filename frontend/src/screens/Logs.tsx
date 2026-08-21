import { LogView } from "../components/LogView";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useT } from "../i18n";

type Props = {
  serverId: string;
  projectId: string;
  kind: string;
  name: string;
  onBack: () => void;
};

// Полноэкранный поток. Отдельный экран нужен потому, что в карточке проекта
// видно строк двадцать, а разбор происшествия начинается с прокрутки на
// несколько сотен.
export function Logs({ serverId, projectId, kind, name, onBack }: Props) {
  const t = useT();
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button dense variant="ghost" onClick={onBack}>
          {t.project.back}
        </Button>
        <span className="truncate text-sm font-semibold">{name}</span>
        <span className="truncate text-xs text-fg-muted">{t.logs.title}</span>
      </div>

      <Card
        className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0 [&>div]:flex-1 [&>div]:p-0"
      >
        <LogView
          serverId={serverId}
          projectId={projectId}
          kind={kind}
          className="h-full"
        />
      </Card>
    </div>
  );
}
