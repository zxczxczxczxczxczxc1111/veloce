import { useEffect, useMemo, useRef, useState } from "react";
import { useFormat } from "../format";
import { useT } from "../i18n";
import { memo } from "react";
import { useLogs, type LogLine } from "../state/logs";
import { Button } from "./ui/Button";

type Props = {
  serverId: string;
  projectId: string;
  kind: string;
  /** Работает ли проект: по этому признаку поток возобновляется после обрыва. */
  live: boolean;
  /** Высота потока. На экране логов во весь рост, в карточке проекта ниже. */
  className?: string;
};

type PanelProps = {
  lines: LogLine[];
  paused: boolean;
  setPaused: (v: boolean) => void;
  error: string | null;
  /** Поток оборван, ждём подъёма проекта. */
  waiting?: boolean;
  className?: string;
};

// Отставание от низа, при котором прокрутка всё ещё считается «в конце».
// Ноль сюда ставить нельзя: субпиксельные высоты строк дают остаток в доли
// пикселя, и автопрокрутка отключалась бы сама собой на ровном месте.
const BOTTOM_SLACK = 24;

// LogView это проводка: берёт поток и отдаёт его панели. Разделение нужно не
// ради красоты, а чтобы панель можно было прогнать под настоящей нагрузкой без
// Go-рантайма: иначе «интерфейс не подвисает» остаётся словами.
export function LogView({ serverId, projectId, kind, live, className = "" }: Props) {
  const logs = useLogs(serverId, projectId, kind, live);
  return (
    <LogPanel
      lines={logs.lines}
      paused={logs.paused}
      setPaused={logs.setPaused}
      error={logs.error}
      waiting={logs.waiting}
      className={className}
    />
  );
}

export function LogPanel({
  lines,
  paused,
  setPaused,
  error,
  waiting = false,
  className = "",
}: PanelProps) {
  const t = useT();
  const f = useFormat();
  const [filter, setFilter] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  // Сколько строк пришло, пока человек читал выше. Кнопка «вниз» без числа
  // не говорит, много ли он пропустил.
  const [unseen, setUnseen] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);
  // Признак «держимся за низ» живёт в ref, а не только в состоянии: прокрутка
  // назначается в следующем кадре, и к этому моменту человек уже мог уехать
  // вверх. Состояние там ещё старое, и автопрокрутка утащила бы его обратно.
  const stick = useRef(true);
  // Длина списка для слушателя прокрутки: он создаётся один раз и текущего
  // значения из замыкания не видит.
  const lenRef = useRef(0);

  // Фильтр применяется к буферу здесь, а не на сервере: перезапускать
  // `docker logs -f` на каждый набранный символ нельзя.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === "") return lines;
    // Служебные строки фильтр не прячет: обрыв потока это часть картины, а не
    // содержимое лога, и терять его при поиске нельзя.
    return lines.filter((l) => l.system === true || l.text.toLowerCase().includes(q));
  }, [lines, filter]);

  lenRef.current = shown.length;

  // Автопрокрутка отключается, как только человек ушёл вверх, и включается
  // обратно, когда он сам вернулся вниз. Без этого прочитать что-либо в живом
  // логе физически невозможно: строка уезжает из-под курсора.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    if (!stick.current) {
      setUnseen(shown.length - seenCount.current);
      return;
    }
    setUnseen(0);
    // Прокрутка в СЛЕДУЮЩЕМ кадре: служебные строки и переносы длинных строк
    // меняют высоту уже после того, как React обновил разметку, и прокрутка
    // «сейчас» промахивается мимо конца.
    const id = requestAnimationFrame(() => {
      // Ещё одна проверка: между планированием кадра и его выполнением
      // человек мог схватиться за колесо.
      if (!stick.current) return;
      box.scrollTop = box.scrollHeight;
      seenCount.current = shown.length;
    });
    return () => cancelAnimationFrame(id);
  }, [shown, atBottom]);

  // Слушатель вешается на сам элемент, а НЕ через onScroll React: событие
  // прокрутки не всплывает, и в webview обработчик React до него не доходит -
  // проверено, автопрокрутка утаскивала экран вниз, сколько ни крути колесо.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const onScroll = () => {
      const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
      stick.current = distance <= BOTTOM_SLACK;
      if (stick.current) seenCount.current = lenRef.current;
      setAtBottom(stick.current);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);

  function toBottom() {
    const box = boxRef.current;
    if (box === null) return;
    box.scrollTop = box.scrollHeight;
    stick.current = true;
    seenCount.current = shown.length;
    setAtBottom(true);
    setUnseen(0);
  }

  return (
    // min-h-0 и flex-1 обязательны оба. Без них блок с логом растёт по
    // содержимому, прокручивается ВСЯ страница вместо потока, а автопрокрутка
    // никогда не доезжает до низа: scrollHeight у нескроллящегося элемента
    // равен его высоте.
    <div className={"flex min-h-0 flex-1 flex-col " + className}>
      <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t.logs.filter}
          aria-label={t.logs.filter}
          className="h-8 flex-1 rounded-lg border border-border bg-fill-subtle px-3 text-sm text-foreground placeholder:text-fg-muted transition-colors hover:border-border-hover"
        />
        {waiting && (
          <span className="shrink-0 text-xs text-accent">{t.logs.waitingStream}</span>
        )}
        <span className="num w-28 shrink-0 text-right text-xs text-fg-muted">
          {t.fmt(t.logs.counter, {
            shown: String(shown.length),
            total: String(lines.length),
          })}
        </span>
        <Button dense onClick={() => setPaused(!paused)}>
          {paused ? t.logs.resume : t.logs.pause}
        </Button>
      </div>

      <div
        ref={boxRef}
        className="num min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all px-5 py-3 font-mono text-xs leading-relaxed"
      >
        {error !== null && <p className="text-down">{error}</p>}
        {error === null && shown.length === 0 && (
          <p className="text-fg-muted">{t.logs.empty}</p>
        )}
        {/* Ключ по номеру строки, а не по индексу: индекс сдвигается на
            каждом срезе кольца, и React переписывает весь список целиком. */}
        {shown.map((l) => (
          <Row key={l.id} text={l.text} system={l.system === true} />
        ))}
      </div>

      {/* Кнопка возврата появляется только когда автопрокрутка отключена:
          висеть постоянно ей незачем. Число пропущенных строк обязательно:
          без него непонятно, вернуться сейчас или дочитать. */}
      {!atBottom && (
        <div className="border-t border-border px-5 py-2">
          <Button dense variant="accent" onClick={toBottom}>
            {unseen > 0 ? f.plural(unseen, t.logs.newLines) : t.logs.toBottom}
          </Button>
        </div>
      )}
    </div>
  );
}

// Row вынесена и мемоизирована: содержимое уже показанной строки не меняется
// никогда, и переписывать её на каждой пачке незачем. Вместе с постоянным
// ключом это и снимает подвисание на болтливом сервисе.
//
// content-visibility здесь ПРОБОВАЛСЯ и убран как ненужный. Он давал прирост
// только пока блок с логом не был ограничен по высоте: тогда прокручивалась
// вся страница, браузер считал раскладку всех пяти тысяч строк, и оценка
// высоты это прятала. С ограниченным контейнером браузер и так не трогает то,
// что за пределами экрана, а оценка высоты вместо настоящей мешает
// автопрокрутке.
const Row = memo(function Row({ text, system }: { text: string; system: boolean }) {
  if (system) {
    // Служебная строка отличается от строки проекта и цветом, и линиями:
    // спутать «панель говорит» с «сервис говорит» нельзя.
    return (
      <div className="my-1 flex items-center gap-3 text-accent">
        <span className="h-px flex-1 bg-accent/30" />
        <span className="shrink-0">{text}</span>
        <span className="h-px flex-1 bg-accent/30" />
      </div>
    );
  }
  return <div className="text-fg-secondary">{text}</div>;
});
