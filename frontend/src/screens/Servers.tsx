import { useCallback, useEffect, useState } from "react";
import { ServersService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import type { KnownHostEntry } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/transport";
import type { Server } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/store";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useT } from "../i18n";
import { useConnState, type ConnState } from "../state/conn";
import { ServerForm } from "./ServerForm";

type Props = {
  servers: Server[];
  /** Перечитать список после сохранения или удаления. */
  onChanged: () => Promise<void> | void;
  /** Уйти на обзор сервера: подключились - значит показываем сервер. */
  onOpen: (id: string) => void;
};

export function Servers({ servers, onChanged, onOpen }: Props) {
  const t = useT();
  // null - форма закрыта, "new" - создание, иначе правим этот сервер.
  const [editing, setEditing] = useState<string | null>(null);

  const save = useCallback(
    async (s: Server) => {
      // ID выдаём здесь, а не в форме: форма не должна знать про хранилище.
      // randomUUID есть в WebView2 и не требует ни библиотеки, ни счётчика,
      // который разъедется между запусками.
      const withID = s.id === "" ? { ...s, id: crypto.randomUUID() } : s;
      await ServersService.Save(withID);
      setEditing(null);
      await onChanged();
    },
    [onChanged],
  );

  return (
    <div className="flex flex-col gap-4">
      {editing === null ? (
        <div className="flex justify-end">
          <Button variant="accent" onClick={() => setEditing("new")}>
            {t.servers.add}
          </Button>
        </div>
      ) : (
        <ServerForm
          server={servers.find((s) => s.id === editing) ?? null}
          servers={servers}
          onSave={(s) => void save(s)}
          onCancel={() => setEditing(null)}
        />
      )}

      {servers.length === 0 && editing === null && (
        <Card>
          <p className="text-sm text-fg-muted">{t.servers.empty}</p>
        </Card>
      )}

      {servers.map((s) => (
        <ServerCard
          key={s.id}
          server={s}
          servers={servers}
          onEdit={() => setEditing(s.id)}
          onChanged={onChanged}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

type CardProps = {
  server: Server;
  servers: Server[];
  onEdit: () => void;
  onChanged: () => Promise<void> | void;
  onOpen: (id: string) => void;
};

function ServerCard({ server, servers, onEdit, onChanged, onOpen }: CardProps) {
  const t = useT();
  const state = useConnState(server.id);
  // null - ещё не читали, пустой массив - хост не подтверждён. У одного хоста
  // бывает по записи на алгоритм ключа, поэтому список, а не строка.
  const [fingerprints, setFingerprints] = useState<KnownHostEntry[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFingerprint = useCallback(async () => {
    try {
      setFingerprints((await ServersService.Fingerprints(server.id)) ?? []);
    } catch (e: unknown) {
      // Отпечаток не критичен для работы карточки, но молчать про сбой нельзя:
      // пустой список читается как «хост не подтверждён», а это другое.
      setError(message(e));
      setFingerprints(null);
    }
  }, [server.id]);

  useEffect(() => {
    void loadFingerprint();
  }, [loadFingerprint]);

  // Подключение и подтверждение ключа меняют known_hosts, отпечаток надо
  // перечитать: иначе карточка показывает вчерашнее состояние файла.
  useEffect(() => {
    if (state.kind !== "connected") return;
    void loadFingerprint();
    onOpen(server.id);
  }, [state.kind, loadFingerprint, onOpen, server.id]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      setError(message(e));
    }
  }

  const jump = servers.find((x) => x.id === server.jumpVia);
  const name = server.label !== "" ? server.label : server.host;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <StateDot state={state} />
          {name}
        </span>
      }
      actions={
        <>
          <Button
            dense
            onClick={() => void run(() => ServersService.Connect(server.id))}
            disabled={state.kind === "connecting"}
          >
            {t.servers.connect}
          </Button>
          <Button dense variant="ghost" onClick={onEdit}>
            {t.servers.edit}
          </Button>
          {confirmDelete ? (
            <>
              <Button
                dense
                variant="danger"
                onClick={() =>
                  void run(async () => {
                    await ServersService.Delete(server.id);
                    await onChanged();
                  })
                }
              >
                {t.fmt(t.servers.confirmDelete, { name })}
              </Button>
              <Button dense variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t.servers.cancel}
              </Button>
            </>
          ) : (
            <Button dense variant="ghost" onClick={() => setConfirmDelete(true)}>
              {t.servers.delete}
            </Button>
          )}
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-fg-muted">{t.servers.host}</dt>
        <dd className="num">
          {server.user !== "" ? server.user + "@" : ""}
          {server.host}:{server.port === 0 ? 22 : server.port}
        </dd>

        <dt className="text-fg-muted">{t.servers.useAgent}</dt>
        <dd className="text-fg-secondary">
          {server.useAgent
            ? "on"
            : server.keyPath !== ""
              ? server.keyPath
              : "off"}
        </dd>

        {jump !== undefined && (
          <>
            <dt className="text-fg-muted">{t.servers.jumpVia}</dt>
            <dd className="text-fg-secondary">
              {jump.label !== "" ? jump.label : jump.host}
            </dd>
          </>
        )}

        <dt className="text-fg-muted">{t.servers.fingerprint}</dt>
        <dd className="flex items-start gap-3">
          {fingerprints !== null && fingerprints.length > 0 ? (
            <>
              <span className="flex min-w-0 flex-col gap-0.5">
                {fingerprints.map((f) => (
                  // Алгоритм рядом с отпечатком обязателен: иначе человек
                  // сравнивает ed25519 из файла с ecdsa из диалога и делает
                  // вывод о подмене там, где ничего не менялось.
                  <span key={f.type + f.fingerprint} className="num truncate">
                    <span className="text-fg-muted">{f.type} </span>
                    <span className="text-fg-secondary">{f.fingerprint}</span>
                  </span>
                ))}
              </span>
              <Button
                dense
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    await ServersService.ForgetHost(server.id);
                    await loadFingerprint();
                  })
                }
              >
                {t.servers.forget}
              </Button>
            </>
          ) : (
            <span className="text-fg-muted">{t.servers.fingerprintNone}</span>
          )}
        </dd>
      </dl>

      <HostKeyPrompt
        state={state}
        onTrust={(fp) =>
          void run(async () => {
            // Отпечаток идёт ИМЕННО тот, который показан на экране. Запросить
            // его заново перед вызовом значит превратить диалог в театр:
            // сверять на стороне Go будет не с чем.
            await ServersService.TrustHost(server.id, fp);
            await loadFingerprint();
          })
        }
        onForget={() =>
          void run(async () => {
            await ServersService.ForgetHost(server.id);
            await loadFingerprint();
          })
        }
      />

      <StateNote state={state} jumpHost={jump?.host ?? server.host} />

      {error !== null && <p className="mt-3 text-sm text-down">{error}</p>}
    </Card>
  );
}

function HostKeyPrompt({
  state,
  onTrust,
  onForget,
}: {
  state: ConnState;
  onTrust: (fingerprint: string) => void;
  onForget: () => void;
}) {
  const t = useT();

  if (state.kind === "hostKeyUnknown") {
    return (
      <div className="mt-4 rounded-lg border border-border bg-elevated p-4">
        <p className="text-sm font-medium">{t.servers.hostKeyUnknown}</p>
        <p className="num mt-1 text-sm text-fg-secondary">
          {t.fmt(t.servers.hostKeyPrompt, { fingerprint: state.fingerprint })}
        </p>
        {/* Автоматически принимать ключ нельзя ни при каких условиях: жмёт
            человек и жмёт по показанному отпечатку. */}
        <div className="mt-3 flex gap-2">
          <Button dense variant="accent" onClick={() => onTrust(state.fingerprint)}>
            {t.servers.trust}
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === "hostKeyChanged") {
    return (
      <div className="mt-4 rounded-lg border border-down/25 bg-elevated p-4">
        <p className="text-sm font-medium text-down">{t.servers.hostKeyChanged}</p>
        <p className="num mt-1 text-sm text-fg-secondary">
          {t.fmt(t.servers.hostKeyChangedPrompt, {
            known: state.known,
            fingerprint: state.fingerprint,
          })}
        </p>
        {/* Кнопки «доверять» здесь нет намеренно. Чтобы принять новый ключ,
            надо сначала осознанно забыть старый: разницу между пересборкой
            сервера и подменой видит только человек. */}
        <div className="mt-3 flex gap-2">
          <Button dense variant="danger" onClick={onForget}>
            {t.servers.forget}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

// Каждый вид отказа выглядит по-своему: общее серое «произошла ошибка»
// запрещено спекой раздела 10.
function StateNote({ state, jumpHost }: { state: ConnState; jumpHost: string }) {
  const t = useT();
  switch (state.kind) {
    case "authFailed":
      return <p className="mt-3 text-sm text-down">{t.errors.authFailed}</p>;
    case "jumpFailed":
      return (
        <p className="mt-3 text-sm text-down">
          {t.fmt(t.errors.jumpFailed, { host: jumpHost })}
        </p>
      );
    case "degraded":
      return (
        <p className="mt-3 text-sm text-fg-muted">
          {t.fmt(t.errors.disconnected, {
            time:
              state.lastOkAt === 0
                ? "-"
                : new Date(state.lastOkAt).toLocaleTimeString(),
          })}
        </p>
      );
    default:
      return null;
  }
}

function StateDot({ state }: { state: ConnState }) {
  const t = useT();
  const map: Record<ConnState["kind"], { cls: string; label: string }> = {
    idle: { cls: "bg-fg-faint", label: t.servers.state.idle },
    connecting: {
      cls: "bg-accent motion-safe:animate-pulse",
      label: t.servers.state.connecting,
    },
    connected: { cls: "bg-up", label: t.servers.state.connected },
    degraded: { cls: "bg-accent", label: t.servers.state.degraded },
    disconnected: { cls: "bg-down", label: t.servers.state.disconnected },
    authFailed: { cls: "bg-down", label: t.errors.authFailed },
    jumpFailed: { cls: "bg-down", label: t.servers.state.disconnected },
    hostKeyUnknown: { cls: "bg-accent", label: t.servers.hostKeyUnknown },
    hostKeyChanged: { cls: "bg-down", label: t.servers.hostKeyChanged },
  };
  const v = map[state.kind];
  return (
    <span
      // Точка не единственный носитель смысла: рядом всегда есть название, а у
      // самой точки подпись. Цветом одним состояние не передаётся.
      title={v.label}
      aria-label={v.label}
      className={"inline-block h-2 w-2 shrink-0 rounded-full " + v.cls}
    />
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
