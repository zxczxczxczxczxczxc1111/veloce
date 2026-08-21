type Props = {
  points: number[];
  /** Верх шкалы. null - плавающая ось по максимуму окна. */
  max: number | null;
  /** Подпись для читателя с экранным диктором: линия сама по себе немая. */
  label: string;
};

const W = 220;
const H = 40;
const PAD = 2; // чтобы линия толщиной 2 не срезалась краем

// Своя полилиния, без библиотеки: 150 точек одной линией это меньше кода, чем
// настройка чужого графика, и не тянет в сборку лишние 40 килобайт.
//
// Осей, сетки и подписей здесь нет намеренно. Спарклайн отвечает на вопрос
// «куда движется», а точное значение стоит рядом крупными цифрами. Вторая
// шкала на плитке 220x40 не читается и только шумит.
export function Sparkline({ points, max, label }: Props) {
  // Одной точкой линию не построить: рисуем пустое место той же высоты, иначе
  // плитка прыгает на втором такте.
  if (points.length < 2) {
    return <div className="h-10 w-full" aria-hidden="true" />;
  }

  // Плавающая ось у сети: у трафика нет естественного потолка. У процентов
  // ось фиксированная 0-100, иначе спокойный сервер рисует панику на ровном
  // месте, потому что шкала подстраивается под шум в полпроцента.
  const top = max ?? Math.max(...points, 1);
  const stepX = (W - PAD * 2) / (points.length - 1);

  const d = points
    .map((v, i) => {
      const x = PAD + i * stepX;
      const clamped = Math.min(Math.max(v, 0), top);
      const y = H - PAD - (clamped / top) * (H - PAD * 2);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    })
    .join(" ");

  const lastX = PAD + (points.length - 1) * stepX;
  const lastY =
    H - PAD - (Math.min(Math.max(points[points.length - 1], 0), top) / top) * (H - PAD * 2);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      // Растягиваем по ширине плитки, высота фиксированная: тянуть высоту
      // значит менять наклон линии от размера окна, а наклон здесь и есть
      // сообщение.
      preserveAspectRatio="none"
      className="h-10 w-full"
      role="img"
      aria-label={label}
    >
      <path
        d={d}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Без этого растяжение по X раздавливает и толщину линии тоже.
        vectorEffect="non-scaling-stroke"
      />
      {/* Точка на конце: глаз должен находить «сейчас» без поиска. Это путь
          нулевой длины с круглым концом, а не circle: при растяжении по X
          кружок превратился бы в овал, а обводка не растягивается. */}
      <path
        d={`M${lastX.toFixed(1)} ${lastY.toFixed(1)}L${lastX.toFixed(1)} ${lastY.toFixed(1)}`}
        stroke="var(--color-accent)"
        strokeWidth={5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
