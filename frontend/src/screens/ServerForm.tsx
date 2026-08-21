import { useId, useState } from "react";
import type { Server } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";
import { useT } from "../i18n";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Field } from "../components/ui/Field";

type Props = {
  /** null - создаём новый сервер. */
  server: Server | null;
  /** Весь список: из него набираются кандидаты в бастионы. */
  servers: Server[];
  onSave: (s: Server) => void;
  onCancel: () => void;
};

// Поля для пароля в форме нет и не появится. Приватный ключ и парольная фраза
// живут в агенте OpenSSH, а публичный инструмент, который складывает чужой
// приватный ключ себе в настройки, живёт до первого поста на Reddit.
export function ServerForm({ server, servers, onSave, onCancel }: Props) {
  const t = useT();
  const jumpId = useId();
  const agentId = useId();

  const [label, setLabel] = useState(server?.label ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  // Порт держим строкой: number-состояние превращает пустое поле в NaN, и
  // человек не может стереть значение, чтобы набрать новое.
  const [port, setPort] = useState(
    server === null || server.port === 0 ? "" : String(server.port),
  );
  const [user, setUser] = useState(server?.user ?? "");
  const [keyPath, setKeyPath] = useState(server?.keyPath ?? "");
  const [useAgent, setUseAgent] = useState(server?.useAgent ?? true);
  const [tags, setTags] = useState((server?.tags ?? []).join(", "));
  const [jumpVia, setJumpVia] = useState(server?.jumpVia ?? "");
  const [touched, setTouched] = useState(false);

  const hostBad = host.trim() === "";
  const userBad = user.trim() === "";

  // Сам себя бастионом выбрать нельзя: цепочка сомкнётся сама на себя, и
  // подключение уйдёт в бесконечный круг.
  const bastions = servers.filter((s) => s.id !== server?.id);

  function submit() {
    setTouched(true);
    if (hostBad || userBad) return;
    const parsed = Number.parseInt(port, 10);
    onSave({
      // Пустой id значит новый сервер: идентификатор выдаёт вызывающий, чтобы
      // форма ничего не знала про хранилище.
      id: server?.id ?? "",
      label: label.trim(),
      host: host.trim(),
      // 0 в хранилище значит 22, это разбирает Go. Своё умолчание тут писать
      // нельзя: два места с одним правилом разъезжаются.
      port: Number.isNaN(parsed) ? 0 : parsed,
      user: user.trim(),
      keyPath: keyPath.trim(),
      useAgent,
      tags: tags
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== ""),
      jumpVia,
    });
  }

  return (
    <Card
      title={server === null ? t.servers.newServer : t.servers.edit}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t.servers.cancel}
          </Button>
          <Button variant="accent" onClick={submit}>
            {t.servers.save}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field
          label={t.servers.label}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Field
          label={t.servers.tags}
          hint={t.servers.tagsHint}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <Field
          label={t.servers.host}
          value={host}
          invalid={touched && hostBad}
          onChange={(e) => setHost(e.target.value)}
        />
        <Field
          label={t.servers.port}
          inputMode="numeric"
          placeholder="22"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
        />
        <Field
          label={t.servers.user}
          value={user}
          invalid={touched && userBad}
          onChange={(e) => setUser(e.target.value)}
        />
        <Field
          label={t.servers.keyPath}
          placeholder="C:\Users\...\.ssh\id_ed25519"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
        />

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={jumpId}
            className="text-[10px] uppercase tracking-[0.08em] text-fg-muted"
          >
            {t.servers.jumpVia}
          </label>
          <select
            id={jumpId}
            value={jumpVia}
            onChange={(e) => setJumpVia(e.target.value)}
            className="h-9 cursor-pointer rounded-lg border border-border bg-fill-subtle px-3 text-sm text-foreground transition-colors hover:border-border-hover"
          >
            <option value="">{t.servers.jumpNone}</option>
            {bastions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label !== "" ? s.label : s.host}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col justify-end gap-1.5">
          <label
            htmlFor={agentId}
            className="flex h-9 cursor-pointer items-center gap-2 text-sm text-fg-secondary"
          >
            <input
              id={agentId}
              type="checkbox"
              checked={useAgent}
              onChange={(e) => setUseAgent(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
            />
            {t.servers.useAgent}
          </label>
        </div>
      </div>

      {touched && (hostBad || userBad) && (
        <p className="mt-4 text-sm text-down">{t.servers.required}</p>
      )}
      <p className="mt-4 text-xs text-fg-muted">{t.servers.noPassword}</p>
    </Card>
  );
}
