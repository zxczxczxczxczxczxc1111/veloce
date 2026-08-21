import { DiagService } from "../../bindings/github.com/zxczxczxczxczxczxc1111/veloce/internal/service";

// Голос интерфейса в общем журнале. Без него в журнале видно только половину
// цепочки: событие отправлено из Go, а дошло ли оно до экрана - неизвестно.
//
// Ошибки записи глотаем намеренно: диагностика не имеет права ломать то, что
// диагностирует.
export function diag(message: string): void {
  void DiagService.Log(message).catch(() => {});
}
