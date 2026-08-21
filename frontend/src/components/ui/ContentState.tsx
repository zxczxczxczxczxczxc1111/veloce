import type { ReactNode } from "react";

type Props = {
  pending: boolean; // данных не было никогда
  fetching: boolean; // данные есть, идёт обновление
  skeleton: ReactNode;
  children: ReactNode;
};

// Единственный способ показать загрузку на экране. Своих состояний загрузки
// заводить нельзя: иначе экран собирается кусками в разное время, и это
// читается как «приложение тормозит».
//
// Почему приглушение, а не скелет везде: скелет честен ровно один раз, когда
// показывать нечего. Дальше данные на экране уже есть, и подменять их серыми
// плашками значит выбрасывать информацию.
export function ContentState({ pending, fetching, skeleton, children }: Props) {
  if (pending) {
    return <div className="animate-pulse">{skeleton}</div>;
  }
  // Спека раздела 9.1: 220 мс и подъём на 10px. Одной прозрачности мало,
  // движение это половина паттерна: без подъёма содержимое просто мигает.
  return (
    <div
      className="motion-safe:animate-[content-in_220ms_cubic-bezier(0.22,1,0.36,1)]"
      style={{
        opacity: fetching ? 0.4 : 1,
        transition: "opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {children}
    </div>
  );
}
