package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/diag"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// Такт событий заметно реже метрик: команды дороже (журнал fail2ban, хвост
// access.log), а пятисекундная точность для событий безопасности не значит
// ничего.
const eventsTick = 30 * time.Second

// Пороги. Собраны в одном месте намеренно: разбросанные по коду числа
// невозможно ни объяснить, ни поменять осознанно.
const (
	// Отказы входа идут фоном круглосуточно. Событие только при заметном
	// всплеске за такт, иначе лента превращается в шум, который перестают
	// читать - а вместе с ним перестают читать и настоящие тревоги.
	failedLoginBurst = 10
	// Ошибки 4xx: скан или подбор. Считаем за такт целиком и отдельно смотрим
	// на самый активный адрес.
	clientErrorBurst = 50
	singleIPBurst    = 25
	// Ошибки 5xx это уже наша сторона: порог низкий.
	serverErrorBurst = 5
	// Больше двух мегабайт за такт не читаем: при обвале лог растёт быстрее,
	// чем его есть смысл разбирать, и панель не должна тянуть его целиком.
	maxTailBytes = 2 << 20
)

const accessLogPath = "/var/log/nginx/access.log"

// EventsService следит за источниками событий сервера.
//
// Сбор идёт ТОЛЬКО чтением: статус fail2ban и хвост журнала nginx. Ничего не
// настраивает и не банит: панель наблюдает, а решения принимает человек.
type EventsService struct {
	app    *application.App
	conns  *ConnRegistry
	events *store.IncidentStore

	mu   sync.Mutex
	stop map[string]context.CancelFunc
	// Предыдущее состояние источников по серверам. Событие это ПРИРОСТ, а не
	// абсолютное число: «всего отказов 7553» это факт за всё время жизни
	// сервера, а не происшествие.
	prev map[string]*sourceState
}

type sourceState struct {
	jails map[string]collect.JailStatus
	// Позиция в access.log. Читаем только новые байты: разбирать весь файл на
	// каждом такте значит гонять по сети мегабайты ради двух строк.
	accessOffset int64
	// primed=false у первого такта: на нём мы только запоминаем позицию и
	// счётчики. Иначе первое же открытие панели выплюнуло бы в ленту весь
	// сегодняшний журнал как «происшествия прямо сейчас».
	primed bool
}

func NewEventsService(app *application.App, conns *ConnRegistry,
	events *store.IncidentStore) *EventsService {

	return &EventsService{
		app: app, conns: conns, events: events,
		stop: map[string]context.CancelFunc{},
		prev: map[string]*sourceState{},
	}
}

func (s *EventsService) Start(serverID string) error {
	diag.Logf("EventsService.Start: сервер=%s", serverID)
	s.Stop(serverID)
	if _, err := s.conns.Get(serverID); err != nil {
		diag.Logf("EventsService.Start: ОТКАЗ, сервер=%s: %v", serverID, err)
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.stop[serverID] = cancel
	if s.prev[serverID] == nil {
		s.prev[serverID] = &sourceState{jails: map[string]collect.JailStatus{}}
	}
	s.mu.Unlock()

	go func() {
		// Первый проход сразу: он ничего не покажет, но запомнит точку
		// отсчёта, и следующий такт уже сможет считать прирост.
		s.tick(ctx, serverID)
		t := time.NewTicker(eventsTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.tick(ctx, serverID)
			}
		}
	}()
	return nil
}

func (s *EventsService) Stop(serverID string) {
	s.mu.Lock()
	cancel, ok := s.stop[serverID]
	delete(s.stop, serverID)
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

// List отдаёт ленту сервера, свежие первыми.
func (s *EventsService) List(serverID string) []store.Incident {
	list := s.events.List(serverID)
	// Разворачиваем: читают ленту сверху, и самое свежее обязано быть там.
	for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
		list[i], list[j] = list[j], list[i]
	}
	return list
}

func (s *EventsService) Unread(serverID string) int { return s.events.Unread(serverID) }

func (s *EventsService) MarkRead(serverID string) error { return s.events.MarkRead(serverID) }

func (s *EventsService) tick(ctx context.Context, serverID string) {
	conn, err := s.conns.Get(serverID)
	if err != nil {
		return
	}

	s.mu.Lock()
	st := s.prev[serverID]
	s.mu.Unlock()
	if st == nil {
		return
	}

	var found []store.Incident
	found = append(found, s.checkFail2ban(ctx, conn, serverID, st)...)
	found = append(found, s.checkNginx(ctx, conn, serverID, st)...)
	st.primed = true

	if len(found) == 0 {
		return
	}
	if err := s.events.AppendMany(found); err != nil {
		diag.Logf("events: не сохранились, сервер=%s: %v", serverID, err)
	}
	diag.Logf("events: новых событий %d, сервер=%s", len(found), serverID)
	s.app.Event.Emit("events:new", map[string]any{
		"serverId": serverID, "count": len(found),
	})
}

func (s *EventsService) checkFail2ban(ctx context.Context, conn transport.Conn,
	serverID string, st *sourceState) []store.Incident {

	res, err := conn.Run(ctx, "fail2ban-client status 2>/dev/null")
	if err != nil || res.Code != 0 {
		return nil // fail2ban не стоит, источник просто выключен
	}

	var out []store.Incident
	now := time.Now().UnixMilli()
	for _, jail := range collect.ParseJailList(res.Stdout) {
		r, err := conn.Run(ctx, "fail2ban-client status "+shellQuote(jail)+" 2>/dev/null")
		if err != nil || r.Code != 0 {
			continue
		}
		cur := collect.ParseJailStatus(r.Stdout)
		was, seen := st.jails[jail]
		st.jails[jail] = cur
		if !seen || !st.primed {
			continue // первая встреча: запоминаем точку отсчёта
		}

		for _, ip := range newStrings(was.BannedIPs, cur.BannedIPs) {
			out = append(out, store.Incident{
				ServerID: serverID, At: now, Source: "fail2ban", Severity: "warning",
				Title:  "Забанен " + ip,
				Detail: "jail " + jail + ", всего банов " + strconv.Itoa(cur.TotalBanned),
			})
		}

		if d := cur.TotalFailed - was.TotalFailed; d >= failedLoginBurst {
			out = append(out, store.Incident{
				ServerID: serverID, At: now, Source: "fail2ban", Severity: "info",
				Title: fmt.Sprintf("Отказов входа: %d за полминуты", d),
				Detail: "jail " + jail + ", сейчас в бане " +
					strconv.Itoa(cur.CurrentlyBanned),
			})
		}
	}
	return out
}

func (s *EventsService) checkNginx(ctx context.Context, conn transport.Conn,
	serverID string, st *sourceState) []store.Incident {

	// Размер и новый хвост одной командой: два вызова дают гонку, между ними
	// лог успевает вырасти, и часть строк теряется навсегда.
	cmd := fmt.Sprintf(
		`f=%s; s=$(stat -c %%s "$f" 2>/dev/null || echo 0); echo "VELOCE_SIZE $s"; `+
			`o=%d; [ "$s" -lt "$o" ] && o=0; `+
			`if [ "$s" -gt "$o" ]; then tail -c +$((o+1)) "$f" | tail -c %d; fi`,
		accessLogPath, st.accessOffset, maxTailBytes)

	res, err := conn.Run(ctx, cmd)
	if err != nil || res.Code != 0 {
		return nil // nginx нет или лог недоступен: источник выключен
	}

	size, body := splitSizeHeader(res.Stdout)
	prevOffset := st.accessOffset
	st.accessOffset = size
	// Первый такт только запоминает позицию: иначе панель вывалила бы в ленту
	// весь сегодняшний журнал как происшествия прямо сейчас.
	if !st.primed || size <= prevOffset {
		return nil
	}

	sum := collect.SummarizeAccess(strings.Split(body, "\n"))
	now := time.Now().UnixMilli()
	var out []store.Incident

	if sum.ServerErrors >= serverErrorBurst {
		out = append(out, store.Incident{
			ServerID: serverID, At: now, Source: "nginx", Severity: "critical",
			Title: fmt.Sprintf("Ошибок 5xx: %d за полминуты", sum.ServerErrors),
			Detail: fmt.Sprintf("чаще всего %s (%d), всего запросов %d",
				sum.TopPath, sum.TopPathCount, sum.Total),
		})
	}

	// Всплеск с ОДНОГО адреса важнее общего числа: так выглядит подбор, а не
	// сломанная ссылка на сайте.
	if sum.TopIPCount >= singleIPBurst {
		out = append(out, store.Incident{
			ServerID: serverID, At: now, Source: "nginx", Severity: "warning",
			Title:  fmt.Sprintf("%s: %d ошибок за полминуты", sum.TopIP, sum.TopIPCount),
			Detail: fmt.Sprintf("чаще всего %s (%d)", sum.TopPath, sum.TopPathCount),
		})
	} else if sum.ClientErrors >= clientErrorBurst {
		out = append(out, store.Incident{
			ServerID: serverID, At: now, Source: "nginx", Severity: "warning",
			Title: fmt.Sprintf("Ошибок 4xx: %d за полминуты", sum.ClientErrors),
			Detail: fmt.Sprintf("чаще всего %s (%d), адрес %s (%d)",
				sum.TopPath, sum.TopPathCount, sum.TopIP, sum.TopIPCount),
		})
	}
	return out
}

// splitSizeHeader отделяет строку с размером файла от самого хвоста.
func splitSizeHeader(out string) (int64, string) {
	nl := strings.Index(out, "\n")
	if nl < 0 {
		return 0, ""
	}
	head, body := out[:nl], out[nl+1:]
	if !strings.HasPrefix(head, "VELOCE_SIZE ") {
		return 0, out
	}
	size, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(head, "VELOCE_SIZE ")), 10, 64)
	if err != nil {
		return 0, body
	}
	return size, body
}

// newStrings отдаёт то, чего в старом списке не было.
func newStrings(was, now []string) []string {
	old := make(map[string]bool, len(was))
	for _, v := range was {
		old[v] = true
	}
	var out []string
	for _, v := range now {
		if !old[v] {
			out = append(out, v)
		}
	}
	return out
}
