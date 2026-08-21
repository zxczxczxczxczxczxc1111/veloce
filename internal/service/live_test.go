package service

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// Проверка health-check против НАСТОЯЩЕГО сервера. Переменные те же, что у
// live_test.go в transport и collect. Запросы идут только на чтение: GET по
// адресу, который и так обслуживает живой трафик.
func TestLiveHealthCheck(t *testing.T) {
	host := os.Getenv("VELOCE_LIVE_HOST")
	if host == "" {
		t.Skip("VELOCE_LIVE_HOST не задан")
	}
	cfg := transport.Config{
		Host:    host,
		Port:    22,
		User:    os.Getenv("VELOCE_LIVE_USER"),
		KeyPath: os.Getenv("VELOCE_LIVE_KEY"),
	}
	policy, err := transport.KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := transport.Dial(context.Background(), cfg, policy)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	defer conn.Close()

	reg := NewConnRegistry()
	reg.Set("live", conn)
	h := NewHealthService(reg)

	// Живое приложение на петле: именно тот случай, ради которого проверка и
	// запускается НА СЕРВЕРЕ - снаружи этот адрес недостижим.
	alive := os.Getenv("VELOCE_LIVE_HEALTH_URL")
	if alive == "" {
		alive = "http://127.0.0.1:3000"
	}
	ok, err := h.Check("live", alive)
	if err != nil {
		t.Fatalf("проверка живого адреса: %v", err)
	}
	t.Logf("живой адрес %s: код=%d ok=%v последний успех=%d", alive, ok.Code, ok.OK, ok.LastOkAt)
	if !ok.OK {
		t.Fatalf("живое приложение не ответило: %+v", ok)
	}

	// Заведомо закрытый порт: curl отдаёт 000, то есть ответа не было вовсе.
	// Ноль обязан читаться как «нет ответа», а не как код ответа.
	dead, err := h.Check("live", "http://127.0.0.1:9")
	if err != nil {
		t.Fatalf("проверка мёртвого адреса: %v", err)
	}
	t.Logf("мёртвый адрес: код=%d ok=%v последний успех=%d", dead.Code, dead.OK, dead.LastOkAt)
	if dead.OK {
		t.Fatal("закрытый порт засчитан как здоровье")
	}
	if dead.LastOkAt != 0 {
		t.Fatal("у адреса, который ни разу не отвечал, взялось время успеха")
	}

	// Повторная проверка живого адреса после падения соседнего: время успеха
	// принадлежит адресу, а не сервису целиком.
	again, err := h.Check("live", alive)
	if err != nil {
		t.Fatal(err)
	}
	if again.LastOkAt < ok.LastOkAt {
		t.Fatal("время последнего успеха поехало назад")
	}
}

// TestLiveEventSources проверяет детекторы на НАСТОЯЩЕМ сервере: команды те
// же, что в такте, только читаем и печатаем, ничего не сохраняя.
func TestLiveEventSources(t *testing.T) {
	host := os.Getenv("VELOCE_LIVE_HOST")
	if host == "" {
		t.Skip("VELOCE_LIVE_HOST не задан")
	}
	cfg := transport.Config{
		Host: host, Port: 22,
		User:    os.Getenv("VELOCE_LIVE_USER"),
		KeyPath: os.Getenv("VELOCE_LIVE_KEY"),
	}
	policy, err := transport.KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := transport.Dial(context.Background(), cfg, policy)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	defer conn.Close()

	es, err := store.OpenIncidents(t.TempDir() + "/events.json")
	if err != nil {
		t.Fatal(err)
	}
	reg := NewConnRegistry()
	reg.Set("live", conn)
	svc := NewEventsService(nil, reg, es)
	st := &sourceState{jails: map[string]collect.JailStatus{}}
	svc.prev["live"] = st
	ctx := context.Background()

	// Первый проход: только запоминаем точку отсчёта.
	if got := svc.checkFail2ban(ctx, conn, "live", st); len(got) != 0 {
		t.Fatalf("первый проход fail2ban выдал события: %+v", got)
	}
	if got := svc.checkNginx(ctx, conn, "live", st); len(got) != 0 {
		t.Fatalf("первый проход nginx выдал события: %+v", got)
	}
	st.primed = true

	for jail, s := range st.jails {
		t.Logf("jail %s: отказов всего=%d, банов всего=%d, сейчас в бане=%d %v",
			jail, s.TotalFailed, s.TotalBanned, s.CurrentlyBanned, s.BannedIPs)
	}
	t.Logf("позиция в access.log: %d байт", st.accessOffset)
	if st.accessOffset == 0 {
		t.Fatal("журнал nginx не прочитан: детектор всплесков работать не будет")
	}

	// Второй проход через паузу: показывает, что видит панель за такт.
	time.Sleep(20 * time.Second)
	found := append(svc.checkFail2ban(ctx, conn, "live", st),
		svc.checkNginx(ctx, conn, "live", st)...)
	t.Logf("за 20 секунд наблюдения событий: %d", len(found))
	for _, e := range found {
		t.Logf("  [%s] %s | %s", e.Severity, e.Title, e.Detail)
	}
}
