package service

import (
	"context"
	"os"
	"testing"

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
