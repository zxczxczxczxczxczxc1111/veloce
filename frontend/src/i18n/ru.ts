export const ru = {
  app: {
    language: "Язык",
  },
  servers: {
    title: "Серверы",
    add: "Добавить сервер",
    empty: "Серверов пока нет",
    connect: "Подключиться",
    filter: "Фильтр",
    hostKeyUnknown: "Хост неизвестен",
    hostKeyPrompt: "Отпечаток ключа: {fingerprint}. Доверять этому хосту?",
  },
  overview: {
    cpu: "Процессор",
    memory: "Память",
    disk: "Диск",
    network: "Сеть",
    uptime: "Аптайм",
    waiting: "Ждём второй замер",
  },
  projects: {
    title: "Проекты",
    running: "Работает",
    stopped: "Лежит",
    unknown: "Неизвестно",
    restart: "Перезапустить",
    confirmRestart: "Перезапустить {name}?",
    showAll: "Показать системные",
  },
  logs: {
    title: "Логи",
    filter: "Фильтр",
    pause: "Пауза",
    resume: "Продолжить",
    empty: "Логов пока нет",
  },
  errors: {
    disconnected: "Связи нет, данные от {time}",
    authFailed: "Ключ не принят",
    jumpFailed: "Бастион {host} не отвечает",
    actionFailed: "{name} не поднялся за 30 секунд",
  },
};

// Тип выводится БЕЗ as const. С ним каждое свойство получило бы литеральный
// тип ("Серверы" вместо string), и английский словарь перестал бы
// присваиваться: Type '"Servers"' is not assignable to type '"Серверы"'.
// А цель ровно обратная - чтобы компилятор ловил ПРОПУЩЕННЫЙ ключ в переводе,
// а не совпадение текстов.
export type Dict = typeof ru;
