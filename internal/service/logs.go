package service

import (
	"bufio"
	"context"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
)

// Пакет transport здесь НЕ импортируется: соединение приходит через
// s.conns.Get и наружу отдаётся интерфейсом. Неиспользуемый импорт в Go это
// ошибка компиляции, а не предупреждение.

// Логи льются быстрее, чем интерфейс успевает рисовать, поэтому строки копятся
// и уходят пачкой. Событие на каждую строку это гарантированно полумёртвый
// интерфейс на любом болтливом сервисе.
const (
	logFlushInterval = 100 * time.Millisecond
	logRingSize      = 5000
)

type ring struct {
	mu   sync.Mutex
	buf  []string
	size int
}

func newRing(size int) *ring { return &ring{size: size} }

func (r *ring) push(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, line)
	if len(r.buf) > r.size {
		r.buf = r.buf[len(r.buf)-r.size:]
	}
}

func (r *ring) lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.buf))
	copy(out, r.buf)
	return out
}

type LogBatch struct {
	// ServerID обязателен: буфер на стороне Go разделён по паре сервер-проект,
	// а событие без сервера склеивало бы на экране логи `nginx` с машины A и
	// `nginx` с машины B в один поток.
	ServerID  string   `json:"serverId"`
	ProjectID string   `json:"projectId"`
	Lines     []string `json:"lines"`
}

// LogStreamEvent сообщает интерфейсу, что с потоком. Без него остановка
// контейнера выглядит как «логи почему-то замолчали»: `docker logs -f`
// завершается вместе с контейнером, и отличить это от тишины в сервисе
// человек не может никак.
type LogStreamEvent struct {
	ServerID  string `json:"serverId"`
	ProjectID string `json:"projectId"`
	// started - поток открыт, ended - поток кончился сам (контейнер
	// остановлен, юнит убит, соединение отвалилось).
	State string `json:"state"`
}

// stream - один открытый поток. Отдельная сущность нужна из-за гонки при
// перезапуске: старый поток заканчивается уже ПОСЛЕ того, как новый занял тот
// же ключ, и его уборка отменяла чужой, только что открытый поток. Экран на
// это отвечал бесконечным кругом «оборвался - открыли заново».
type stream struct {
	cancel context.CancelFunc
	ring   *ring
}

type LogsService struct {
	app   *application.App
	conns *ConnRegistry
	mu    sync.Mutex
	// Ключ составной: serverID + projectID. По одному projectID открытые логи
	// `nginx` на сервере A убивали бы стрим `nginx` на сервере B, а Buffered
	// возвращал бы перемешанные строки двух машин.
	streams map[string]*stream
}

func logKey(serverID, projectID string) string { return serverID + "\x00" + projectID }

func NewLogsService(app *application.App, conns *ConnRegistry) *LogsService {
	return &LogsService{
		app: app, conns: conns,
		streams: map[string]*stream{},
	}
}

// Start открывает стрим логов проекта. Повторный вызов для того же проекта
// сначала закрывает предыдущий стрим: иначе `docker logs -f` копится на сервере
// при каждом заходе на экран.
// Start открывает поток. tail - сколько строк истории показать: при первом
// открытии экрана нужна пара сотен для контекста, а при ВОЗОБНОВЛЕНИИ после
// обрыва ноль. Иначе каждое возобновление вываливает ту же историю заново, и
// лог растёт копиями самого себя.
func (s *LogsService) Start(serverID, projectID string,
	kind collect.ProjectKind, tail int) error {

	s.Stop(serverID, projectID)

	conn, err := s.conns.Get(serverID)
	if err != nil {
		return err
	}
	if tail < 0 {
		tail = 0
	}

	n := strconv.Itoa(tail)
	cmd := "docker logs -f --tail " + n + " " + shellQuote(projectID)
	if kind == collect.KindSystemd {
		cmd = "journalctl -u " + shellQuote(projectID) + " -f -n " + n + " --no-pager"
	}

	ctx, cancel := context.WithCancel(context.Background())
	rc, err := conn.Stream(ctx, cmd)
	if err != nil {
		cancel()
		return err
	}

	st := &stream{cancel: cancel, ring: newRing(logRingSize)}
	key := logKey(serverID, projectID)
	s.mu.Lock()
	s.streams[key] = st
	s.mu.Unlock()

	s.app.Event.Emit("logs:stream", LogStreamEvent{
		ServerID: serverID, ProjectID: projectID, State: "started",
	})

	go s.pump(ctx, rc, st, key, serverID, projectID)
	return nil
}

// pump принимает io.ReadCloser и ЗАКРЫВАЕТ его. Раньше здесь стоял голый
// io.Reader, и сессия оставалась висеть после штатного конца потока
// (контейнер остановили) - то есть каждый заход на экран логов оставлял на
// сервере по одному живому `docker logs -f`.
func (s *LogsService) pump(ctx context.Context, rc io.ReadCloser,
	st *stream, key, serverID, projectID string) {

	defer rc.Close()

	// natural=true значит, что поток кончился САМ: контейнер остановлен, юнит
	// убит, соединение отвалилось. Проверять ctx внутри defer нельзя: уборка
	// ниже сама отменяет контекст, а defer выполняются в обратном порядке, и
	// сообщение о конце потока молча не отправлялось вовсе. Именно поэтому в
	// интерфейсе не появлялось ни строчки про обрыв.
	natural := false
	defer func() {
		if !natural {
			return
		}
		s.app.Event.Emit("logs:stream", LogStreamEvent{
			ServerID: serverID, ProjectID: projectID, State: "ended",
		})
	}()

	// Убираем за собой и при штатном конце потока (контейнер остановили), а не
	// только по Stop с фронта. Иначе отменялка и кольцо на 5000 строк остаются
	// в картах навсегда, и память растёт на каждый просмотренный проект.
	defer func() {
		s.mu.Lock()
		// Сверяем личность: под этим ключом уже может лежать ДРУГОЙ,
		// только что открытый поток, и трогать его нельзя. Раньше уборка
		// старого потока отменяла новый, экран получал «оборвался», открывал
		// заново, и так по кругу - лог заполнялся копиями истории, а
		// интерфейс мерцал.
		if cur, ok := s.streams[key]; ok && cur == st {
			delete(s.streams, key)
		}
		s.mu.Unlock()
		st.cancel()
	}()

	sc := bufio.NewScanner(rc)
	// Строка лога может быть длинной (трейсбек, длинный JSON). Умолчание в
	// 64 КБ на строку такие обрезает, поднимаем до мегабайта.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	pending := make(chan string, 1024)
	go func() {
		for sc.Scan() {
			select {
			case pending <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
		close(pending)
	}()

	ticker := time.NewTicker(logFlushInterval)
	defer ticker.Stop()

	var batch []string
	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.app.Event.Emit("logs:batch", LogBatch{
			ServerID: serverID, ProjectID: projectID, Lines: batch,
		})
		batch = nil
	}

	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-pending:
			if !ok {
				// Поток кончился сам, а не по нашей команде.
				natural = true
				flush()
				return
			}
			st.ring.push(line)
			batch = append(batch, line)
		case <-ticker.C:
			flush()
		}
	}
}

func (s *LogsService) Stop(serverID, projectID string) {
	key := logKey(serverID, projectID)
	s.mu.Lock()
	st, ok := s.streams[key]
	delete(s.streams, key)
	s.mu.Unlock()
	if ok {
		st.cancel()
	}
}

// StopServer гасит все стримы одного сервера. Вызывается при отключении:
// без него логи продолжали бы дёргать мёртвое соединение.
func (s *LogsService) StopServer(serverID string) {
	prefix := serverID + "\x00"
	s.mu.Lock()
	var cancels []context.CancelFunc
	for k, st := range s.streams {
		if strings.HasPrefix(k, prefix) {
			cancels = append(cancels, st.cancel)
			delete(s.streams, k)
		}
	}
	s.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// Buffered отдаёт уже накопленные строки: при возврате на экран пользователь
// должен увидеть контекст, а не пустоту в ожидании новой строки.
func (s *LogsService) Buffered(serverID, projectID string) []string {
	s.mu.Lock()
	st, ok := s.streams[logKey(serverID, projectID)]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return st.ring.lines()
}

// shellQuote защищает от имени контейнера с чем-нибудь весёлым внутри.
// Все входные данные с сервера и из конфига считаем недоверенными.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
