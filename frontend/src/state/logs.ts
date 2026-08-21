import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { LogsService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";
import { ProjectKind } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/collect";
import type { LogBatch, LogStreamEvent } from "./events";

// Буфер на стороне интерфейса ограничен так же, как кольцо на стороне Go.
// Держать десятки тысяч строк в состоянии React это способ убить приложение
// своими руками: каждая перерисовка копирует весь массив.
const MAX_LINES = 5000;

// Сколько строк истории просить при первом открытии экрана. При возобновлении
// после обрыва просим НОЛЬ: та же история, приехавшая второй раз, это лог,
// заполненный копиями самого себя.
const TAIL_FIRST = 200;
const TAIL_RESUME = 0;

// Минимальный промежуток между попытками открыть поток. Защита от круга:
// поток, который обрывается сразу после открытия, иначе крутил бы попытки со
// скоростью машины, и интерфейс мерцал бы вместе с ним.
const RETRY_GUARD_MS = 3000;

// LogLine несёт постоянный номер. Без него срез кольца сдвигает все индексы,
// React считает изменившейся КАЖДУЮ из пяти тысяч строк и переписывает весь
// список на каждой пачке. Замерено: пик кадра падает со 150 мс до 20.
export type LogLine = {
  id: number;
  text: string;
  /** Строка от панели, а не от проекта: обрыв потока и его возобновление. */
  system?: boolean;
};

export type Logs = {
  lines: LogLine[];
  paused: boolean;
  setPaused: (v: boolean) => void;
  error: string | null;
  /** true, пока поток оборван и мы ждём, когда проект поднимется. */
  waiting: boolean;
};

export function kindOf(kind: string): ProjectKind {
  // Сравнение, а не приведение: неизвестное значение обязано упереться здесь,
  // а не улететь в подстановку команды на сервере.
  return kind === "docker" ? ProjectKind.KindDocker : ProjectKind.KindSystemd;
}

export function useLogs(
  serverId: string,
  projectId: string,
  kind: string,
  // live - работает ли проект прямо сейчас. Поток возобновляется ТОЛЬКО когда
  // он снова поднялся. Слепые повторы по таймеру тут не годятся: docker logs -f
  // на остановленном контейнере не ждёт, а сразу печатает историю и выходит,
  // то есть каждая попытка лила бы двести строк заново.
  live: boolean,
): Logs {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  // Пауза держится в ref, потому что подписка на событие живёт весь срок
  // экрана: читай она состояние напрямую, обработчик остался бы с тем
  // значением, которое было на момент подписки.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Сквозной счётчик строк на весь экран: номер обязан оставаться уникальным
  // и после того, как строка уехала из кольца.
  const seq = useRef(0);

  // Ожидание держим и в ref: обработчики внутри эффекта создаются один раз и
  // текущего состояния из них не видно.
  const waitingRef = useRef(false);
  waitingRef.current = waiting;

  // Ссылка на попытку открыть поток: дёргает её эффект, следящий за подъёмом
  // проекта, а живёт она внутри другого эффекта.
  const startRef = useRef<(() => Promise<void>) | null>(null);
  const lastStartAt = useRef(0);

  // Подписи берутся из словаря, но читать хук внутри эффекта нельзя, поэтому
  // забираем их заранее.
  const t = useT();
  const streamEndedText = t.logs.streamEnded;
  const streamResumedText = t.logs.streamResumed;

  useEffect(() => {
    let alive = true;
    // resumed=false у первого запуска: отметку «поток возобновлён» ставим
    // только после настоящего обрыва, а не при открытии экрана.
    let resumed = false;
    setLines([]);
    setError(null);
    setWaiting(false);
    seq.current = 0;

    // Служебная строка в самом потоке, а не подпись где-то сбоку: обрыв
    // случился в конкретном месте лога, и видеть его надо там же.
    const mark = (text: string) => {
      setLines((prev) => {
        seq.current += 1;
        const next = prev.concat([{ id: seq.current, text, system: true }]);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    // Поток умирает вместе с проектом: `docker logs -f` завершается, когда
    // контейнер остановлен. Без отметки и повторных попыток панель просто
    // молча замолкает, и понять, что случилось, нельзя.
    const offStream = Events.On("logs:stream", (e: { data: LogStreamEvent }) => {
      if (e.data.serverId !== serverId || e.data.projectId !== projectId) return;
      if (e.data.state !== "ended") return;
      // Отметка ставится ОДИН раз на обрыв: повторные попытки не должны
      // засыпать лог одинаковыми строками.
      if (waitingRef.current) return;
      setWaiting(true);
      mark(streamEndedText);
    });

    // Сначала подписка, потом Start: между этими двумя вызовами уже летят
    // строки, и подписавшись вторым, мы теряли бы начало потока.
    const off = Events.On("logs:batch", (e: { data: LogBatch }) => {
      if (e.data.serverId !== serverId || e.data.projectId !== projectId) return;
      // На паузе строки не копятся вообще. Копить их значит вывалить на
      // человека тысячу строк одним куском в момент снятия паузы.
      if (pausedRef.current) return;
      setLines((prev) => {
        const next = prev.concat(
          (e.data.lines ?? []).map((text) => {
            seq.current += 1;
            return { id: seq.current, text };
          }),
        );
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });

    async function tryStart() {
      if (!alive) return;
      // Ограничитель круга: две попытки подряд быстрее секунд трёх это уже не
      // возобновление, а цикл.
      const now = Date.now();
      if (now - lastStartAt.current < RETRY_GUARD_MS) return;
      lastStartAt.current = now;
      try {
        await LogsService.Start(
          serverId,
          projectId,
          kindOf(kind),
          resumed ? TAIL_RESUME : TAIL_FIRST,
        );
        if (!alive) return;
        if (resumed) {
          setWaiting(false);
          mark(streamResumedText);
        }
        resumed = true;
        setError(null);
        // Уже накопленное на стороне Go: при возврате на экран человек должен
        // увидеть контекст, а не пустоту в ожидании новой строки.
        const buffered = (await LogsService.Buffered(serverId, projectId)) ?? [];
        if (!alive) return;
        setLines((prev) =>
          prev.length === 0
            ? buffered.map((text) => {
                seq.current += 1;
                return { id: seq.current, text };
              })
            : prev,
        );
      } catch (e: unknown) {
        if (!alive) return;
        // Пока ждём подъёма, отказ ожидаем и молчалив.
        if (waitingRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    void tryStart();
    startRef.current = tryStart;

    return () => {
      alive = false;
      startRef.current = null;
      offStream();
      off();
      // Стрим на сервере закрывается вместе с экраном, иначе `docker logs -f`
      // копится на той стороне при каждом заходе.
      void LogsService.Stop(serverId, projectId);
    };
  }, [serverId, projectId, kind]);

  // Проект снова работает, а мы ждали - открываем поток заново. Именно по
  // событию подъёма, а не по времени.
  useEffect(() => {
    if (!live || !waiting) return;
    void startRef.current?.();
    // Проект уже работает, а поток всё равно не держится: пробуем ещё, но
    // редко. Молча, потому что отметка про обрыв уже стоит в логе.
    const id = window.setInterval(() => {
      void startRef.current?.();
    }, RETRY_GUARD_MS * 2);
    return () => window.clearInterval(id);
  }, [live, waiting]);

  const setPausedStable = useCallback((v: boolean) => setPaused(v), []);

  return { lines, paused, setPaused: setPausedStable, error, waiting };
}
