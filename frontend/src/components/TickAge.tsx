import { useEffect, useState } from "react";
import { useFormat } from "../format";
import { useT } from "../i18n";

type Props = {
  /** Отметка последнего такта в миллисекундах. 0 - тактов не было. */
  at: number;
};

// Порог, после которого возраст данных становится тревожным. Метрики идут раз
// в две секунды, проекты раз в пять: десять секунд молчания это уже не
// «немного запаздывает», а «что-то не так».
const STALE_MS = 10_000;

// Возраст данных на экране. Прибор, а не украшение: без него отличить живую
// панель от замершей нельзя в принципе, а спека раздела 10 называет застывшие
// цифры, выглядящие живыми, худшим из отказов.
export function TickAge({ at }: Props) {
  const t = useT();
  const f = useFormat();
  // Своё время, потому что перерисовка от такта тут не помогает: когда такты
  // прекратились, перерисовывать некому, а именно это и надо показать.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (at === 0) {
    return <span className="text-xs text-fg-muted">{t.overview.updatedNever}</span>;
  }

  const stale = now - at > STALE_MS;
  return (
    <span className={"num text-xs " + (stale ? "text-accent" : "text-fg-muted")}>
      {t.fmt(t.overview.updated, { ago: f.ago(at, now) })}
    </span>
  );
}
