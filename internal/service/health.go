package service

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Проверка не должна висеть дольше такта проектов: висящий curl держит SSH-
// сессию и копится по одному на каждую проверку.
const healthTimeout = 5

type HealthResult struct {
	// Configured=false значит, что адрес не задан и проверки нет вовсе. Это
	// НЕ отказ: у большинства проектов health-check не настроен, и рисовать им
	// красное было бы враньём.
	Configured bool `json:"configured"`
	Code       int  `json:"code"`
	OK         bool `json:"ok"`
	// Отметки времени в МИЛЛИСЕКУНДАХ: это родной формат Date в JavaScript, и
	// секунды пришлось бы домножать на той стороне. Секундного разрешения к
	// тому же не хватает, чтобы отличить две проверки подряд.
	CheckedAt int64 `json:"checkedAt"`
	// LastOkAt - время последнего УСПЕШНОГО ответа, а не последней проверки.
	// «Проверено 5 секунд назад» у лежащего сервиса бесполезно, а «последний
	// раз отвечал в 14:32» говорит всё. Переживает неудачные проверки.
	LastOkAt int64 `json:"lastOkAt"`
}

type HealthService struct {
	conns *ConnRegistry
	mu    sync.Mutex
	// Ключ составной: сервер плюс адрес. Один адрес на двух серверах это две
	// разные проверки, а два адреса на одном сервере тем более.
	lastOk map[string]int64
}

func NewHealthService(conns *ConnRegistry) *HealthService {
	return &HealthService{conns: conns, lastOk: map[string]int64{}}
}

func healthKey(serverID, url string) string { return serverID + "\x00" + url }

// Check запускает проверку НА СЕРВЕРЕ. Адрес вида http://localhost:8081/health
// слушает петлю и с машины пользователя недостижим по определению: проверяя
// его отсюда, мы получали бы отказ у совершенно здорового приложения.
//
// Контейнер бывает up и при этом мёртв внутри. Статус от Docker отвечает на
// вопрос «процесс запущен», а не «приложение работает», ради этой разницы
// проверка и нужна.
func (h *HealthService) Check(serverID, url string) (HealthResult, error) {
	if strings.TrimSpace(url) == "" {
		return HealthResult{Configured: false}, nil
	}

	conn, err := h.conns.Get(serverID)
	if err != nil {
		return HealthResult{}, err
	}

	// Адрес приходит из настроек, то есть введён руками. Кавычки обязательны:
	// без них точка с запятой в поле превращается в чужую команду на сервере.
	cmd := "curl -s -o /dev/null -w '%{http_code}' --max-time " +
		strconv.Itoa(healthTimeout) + " " + shellQuote(url)

	res, err := conn.Run(context.Background(), cmd)
	if err != nil {
		return HealthResult{}, err
	}

	now := time.Now().UnixMilli()
	code, _ := strconv.Atoi(strings.TrimSpace(res.Stdout))
	// curl печатает 000, когда ответа не было вовсе: отказ соединения, таймаут,
	// неверное имя. Это не код ответа, а его отсутствие.
	//
	// Перенаправление (3xx) считается ответом. Проверка отвечает на вопрос
	// «приложение живо», а не «эта страница отдаёт 200»: панель на Next.js
	// уводит с корня на логин кодом 307, и строгое «только 2xx» красило бы
	// совершенно здоровое приложение красным. Проверено на проде.
	// 4xx и 5xx это уже отказ: либо приложение сломано, либо адрес указан не
	// тот, и человеку в обоих случаях надо об этом сказать.
	ok := code >= 200 && code < 400

	key := healthKey(serverID, url)
	h.mu.Lock()
	if ok {
		h.lastOk[key] = now
	}
	last := h.lastOk[key]
	h.mu.Unlock()

	return HealthResult{
		Configured: true, Code: code, OK: ok,
		CheckedAt: now, LastOkAt: last,
	}, nil
}
