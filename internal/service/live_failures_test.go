package service

import (
	"context"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
	"golang.org/x/crypto/ssh"
)

// Проверки, которые НАСТОЯЩИМ образом ломают то, за чем панель наблюдает.
// Запускаются только при VELOCE_LIVE_BREAK=1, чтобы обычный прогон никогда не
// трогал ничей сервер. Всё, что тронуто, возвращается на место в том же тесте.
//
// Обрыв связи изображается своим прокси на петле: рвать чужую сеть незачем,
// достаточно оборвать наш собственный сокет.

func liveBreakCfg(t *testing.T) transport.Config {
	t.Helper()
	if os.Getenv("VELOCE_LIVE_BREAK") != "1" {
		t.Skip("VELOCE_LIVE_BREAK не выставлен: тест ломает живые контейнеры")
	}
	host := os.Getenv("VELOCE_LIVE_HOST")
	if host == "" {
		t.Skip("VELOCE_LIVE_HOST не задан")
	}
	return transport.Config{
		Host:    host,
		Port:    22,
		User:    os.Getenv("VELOCE_LIVE_USER"),
		KeyPath: os.Getenv("VELOCE_LIVE_KEY"),
	}
}

// cuttableProxy - TCP-прокси на петле, который умеет резать живые соединения,
// оставаясь на том же порту. Это и есть «выдернули сеть»: для клиента
// соединение обрывается посреди работы, а сервер об этом даже не знает.
type cuttableProxy struct {
	ln     net.Listener
	target string
	mu     chan struct{}
	conns  []net.Conn
	accept bool
}

func newCuttableProxy(t *testing.T, target string) *cuttableProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &cuttableProxy{ln: ln, target: target, mu: make(chan struct{}, 1), accept: true}
	p.mu <- struct{}{}
	go p.serve()
	t.Cleanup(func() { ln.Close(); p.cut() })
	return p
}

func (p *cuttableProxy) lock()   { <-p.mu }
func (p *cuttableProxy) unlock() { p.mu <- struct{}{} }

func (p *cuttableProxy) serve() {
	for {
		c, err := p.ln.Accept()
		if err != nil {
			return
		}
		p.lock()
		allow := p.accept
		p.unlock()
		if !allow {
			c.Close()
			continue
		}
		up, err := net.Dial("tcp", p.target)
		if err != nil {
			c.Close()
			continue
		}
		p.lock()
		p.conns = append(p.conns, c, up)
		p.unlock()
		go func() { io.Copy(up, c); up.Close() }()
		go func() { io.Copy(c, up); c.Close() }()
	}
}

// cut рвёт все живые соединения, оставляя слушателя на месте: клиент видит
// обрыв, но переподключение возможно.
func (p *cuttableProxy) cut() {
	p.lock()
	conns := p.conns
	p.conns = nil
	p.unlock()
	for _, c := range conns {
		c.Close()
	}
}

// deny запрещает новые соединения: сервер стал недостижим совсем.
func (p *cuttableProxy) deny(v bool) {
	p.lock()
	p.accept = !v
	p.unlock()
	if v {
		p.cut()
	}
}

func (p *cuttableProxy) addr() (string, int) {
	a := p.ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port
}

func TestLiveBreakConnectionDropsAndRecovers(t *testing.T) {
	cfg := liveBreakCfg(t)

	proxy := newCuttableProxy(t, net.JoinHostPort(cfg.Host, "22"))
	host, port := proxy.addr()
	through := cfg
	through.Host, through.Port = host, port

	// Ключ хоста тут наш же, но приезжает через петлю: known_hosts про
	// 127.0.0.1 ничего не знает, а тест не про него.
	accept := func(string, ssh.PublicKey) error { return nil }

	conn, err := transport.Dial(context.Background(), through, accept)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	defer conn.Close()

	var states []transport.State
	conn.SetStateHook(func(s transport.State) { states = append(states, s) })

	if _, err := conn.Run(context.Background(), "echo жив"); err != nil {
		t.Fatalf("команда до обрыва: %v", err)
	}

	// Сеть выдернули. Сервер об этом не знает, клиент узнаёт на первой же
	// команде: именно так и выглядит обрыв посреди работы.
	proxy.deny(true)
	_, err = conn.Run(context.Background(), "echo уже нет")
	if err == nil {
		t.Fatal("команда после обрыва прошла, обрыва не случилось")
	}
	t.Logf("после обрыва: %v, состояние %v", err, conn.State())
	if conn.State() == transport.StateConnected {
		t.Fatal("состояние осталось «на связи» при мёртвом соединении")
	}

	// Сеть вернули. Панель обязана подняться САМА, без участия человека.
	proxy.deny(false)
	deadline := time.Now().Add(60 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		if _, last = conn.Run(context.Background(), "echo снова жив"); last == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if last != nil {
		t.Fatalf("переподключение не состоялось за минуту: %v", last)
	}
	t.Logf("переподключились сами, состояние %v, путь состояний %v", conn.State(), states)
	if conn.State() != transport.StateConnected {
		t.Fatalf("после восстановления состояние %v", conn.State())
	}
}

// liveProjects поднимает сервис проектов на живом соединении.
func liveProjects(t *testing.T, cfg transport.Config) (*ProjectsService, *ConnRegistry) {
	t.Helper()
	accept, err := transport.KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := transport.Dial(context.Background(), cfg, accept)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	reg := NewConnRegistry()
	reg.Set("live", conn)
	st, err := store.Open(t.TempDir() + "/servers.json")
	if err != nil {
		t.Fatal(err)
	}
	// app здесь nil: Discover и Action событий не шлют, а тикеры мы не
	// запускаем. Разбуди мы Start, тест упал бы на nil-указателе.
	return NewProjectsService(nil, st, reg), reg
}

func findProject(t *testing.T, ps *ProjectsService, id string) ProjectDTO {
	t.Helper()
	list, err := ps.Discover("live")
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	for _, p := range list {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("проект %s не найден среди %d", id, len(list))
	return ProjectDTO{}
}

func TestLiveBreakStandContainerStopAndStart(t *testing.T) {
	cfg := liveBreakCfg(t)
	ps, _ := liveProjects(t, cfg)

	const stand = "demo-app-test"
	before := findProject(t, ps, stand)
	if before.State != string(collect.StateRunning) {
		t.Skipf("стенд и так не работает (%s), ломать нечего", before.State)
	}

	// Гасим стенд его же кнопкой из панели.
	if err := ps.Action("live", stand, collect.KindDocker, "stop"); err != nil {
		t.Fatalf("остановка стенда: %v", err)
	}
	// Поднимаем обратно ВСЕГДА, даже если проверки ниже упадут.
	defer func() {
		if err := ps.Action("live", stand, collect.KindDocker, "start"); err != nil {
			t.Fatalf("стенд не поднят обратно, это надо чинить руками: %v", err)
		}
		back := findProject(t, ps, stand)
		t.Logf("стенд возвращён: %s (%s)", back.State, back.Status)
		if back.State != string(collect.StateRunning) {
			t.Fatalf("стенд остался в состоянии %s", back.State)
		}
	}()

	// Пауза для человека у экрана: такт проектов идёт раз в пять секунд, и на
	// коротком гашении отличить «панель заметила» от «панель не успела»
	// нельзя. Задаётся VELOCE_LIVE_DOWN_SECONDS, по умолчанию не ждём.
	if sec := os.Getenv("VELOCE_LIVE_DOWN_SECONDS"); sec != "" {
		d, err := time.ParseDuration(sec + "s")
		if err != nil {
			t.Fatalf("VELOCE_LIVE_DOWN_SECONDS: %v", err)
		}
		t.Logf("стенд лежит, держим %s - смотри на экран", d)
		time.Sleep(d)
	}

	down := findProject(t, ps, stand)
	t.Logf("после остановки: состояние=%s статус=%q цифры известны: cpu=%v mem=%v",
		down.State, down.Status, down.CPUKnown, down.MemKnown)
	if down.State != string(collect.StateDown) {
		t.Fatalf("остановленный контейнер показан как %s", down.State)
	}
	// У остановленного контейнера цифр нет вовсе, и прочерк здесь честный.
	if down.CPUKnown || down.MemKnown {
		t.Fatal("у остановленного контейнера взялись цифры потребления")
	}
}

func TestLiveBreakActionOnMissingProject(t *testing.T) {
	cfg := liveBreakCfg(t)
	ps, _ := liveProjects(t, cfg)

	// «Команда не выполнилась»: контейнера нет, docker отвечает отказом.
	// Ошибка обязана доехать до вызывающего с текстом, а не потеряться.
	err := ps.Action("live", "veloce-no-such-container", collect.KindDocker, "restart")
	if err == nil {
		t.Fatal("перезапуск несуществующего контейнера прошёл успешно")
	}
	t.Logf("ошибка команды: %v", err)
	if !strings.Contains(strings.ToLower(err.Error()), "no such container") {
		t.Fatalf("сообщение не объясняет причину: %v", err)
	}
}

func TestLiveBreakContainerThatNeverComesUp(t *testing.T) {
	cfg := liveBreakCfg(t)
	ps, reg := liveProjects(t, cfg)
	conn, err := reg.Get("live")
	if err != nil {
		t.Fatal(err)
	}
	const broken = "veloce-broken-test"

	// Заведомо сломанный контейнер: выходит с ошибкой сразу после старта.
	// Образ alpine на хосте уже есть, из сети ничего не тянем.
	cleanup := func() {
		if _, err := conn.Run(context.Background(),
			"docker rm -f "+broken+" >/dev/null 2>&1; true"); err != nil {
			t.Logf("уборка контейнера не удалась: %v", err)
		}
	}
	cleanup()
	res, err := conn.Run(context.Background(),
		"docker run -d --name "+broken+" alpine sh -c 'exit 1'")
	if err != nil {
		t.Fatalf("создание сломанного контейнера: %v", err)
	}
	if res.Code != 0 {
		t.Fatalf("docker run: %s", strings.TrimSpace(res.Stderr))
	}
	t.Cleanup(cleanup)

	time.Sleep(2 * time.Second)
	first := findProject(t, ps, broken)
	t.Logf("сразу после создания: состояние=%s статус=%q", first.State, first.Status)
	if first.State != string(collect.StateDown) {
		t.Fatalf("контейнер, вышедший с кодом 1, показан как %s", first.State)
	}

	// Панель жмёт «перезапустить». Команда пройдёт успешно, а контейнер всё
	// равно останется лежать: ровно тот случай, ради которого в интерфейсе
	// сделано ожидание подъёма с показом лога.
	if err := ps.Action("live", broken, collect.KindDocker, "restart"); err != nil {
		t.Fatalf("перезапуск: %v", err)
	}
	time.Sleep(3 * time.Second)
	after := findProject(t, ps, broken)
	t.Logf("после перезапуска: состояние=%s статус=%q", after.State, after.Status)
	if after.State == string(collect.StateRunning) {
		t.Fatal("сломанный контейнер внезапно поднялся, тест бессмысленен")
	}
}

// TestLiveBreakWatchTicksDuringOutage печатает то, что интерфейс получает
// КАЖДЫЙ такт во время остановки. Нужен потому, что на экране у остановленного
// контейнера остались цифры потребления, а сервер их не отдаёт: значит врёт
// что-то между ними, и надо видеть каждый шаг.
func TestLiveBreakWatchTicksDuringOutage(t *testing.T) {
	cfg := liveBreakCfg(t)
	ps, _ := liveProjects(t, cfg)
	const stand = "demo-app-test"

	show := func(when string) ProjectDTO {
		p := findProject(t, ps, stand)
		t.Logf("%-14s состояние=%-8s статус=%-32q cpu=%.1f (известно=%v) mem=%d (известно=%v)",
			when, p.State, p.Status, p.CPUPercent, p.CPUKnown, p.MemBytes, p.MemKnown)
		return p
	}

	show("до остановки")
	if err := ps.Action("live", stand, collect.KindDocker, "stop"); err != nil {
		t.Fatalf("остановка: %v", err)
	}
	defer func() {
		if err := ps.Action("live", stand, collect.KindDocker, "start"); err != nil {
			t.Fatalf("стенд не поднят обратно: %v", err)
		}
		show("после подъёма")
	}()

	for i := 1; i <= 4; i++ {
		time.Sleep(4 * time.Second)
		p := show("такт " + strconv.Itoa(i))
		if p.State == string(collect.StateDown) && (p.CPUKnown || p.MemKnown) {
			t.Errorf("такт %d: у остановленного контейнера цифры числятся известными", i)
		}
	}
}
