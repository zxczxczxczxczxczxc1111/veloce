package collect

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// Сбор данных с НАСТОЯЩЕГО сервера, переменные окружения те же, что у
// live_test.go в transport. Только чтение: ни одного изменения на той стороне.
// Без VELOCE_LIVE_HOST молчит.
func TestLiveCollectReadOnly(t *testing.T) {
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

	// Настоящий known_hosts пользователя, безо всякой подмены: заодно
	// проверяем, что политика на живом файле не падает и хост опознаётся.
	policy, err := transport.KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	fp, err := transport.KnownHostFingerprints(transport.HostPort(cfg.Host, cfg.Port))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("отпечатки из настоящего known_hosts: %v", fp)

	conn, err := transport.Dial(context.Background(), cfg, policy)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	defer conn.Close()

	ctx := context.Background()
	hc := NewHostCollector()
	// Первый такт даёт дельты не с чем считать, поэтому берём два.
	if _, err := hc.Collect(ctx, conn); err != nil {
		t.Fatalf("первый замер: %v", err)
	}
	time.Sleep(2 * time.Second)
	snap, err := hc.Collect(ctx, conn)
	if err != nil {
		t.Fatalf("второй замер: %v", err)
	}
	t.Logf("cpu %.1f%%, память %d/%d, аптайм %s, дисков %d, валиден=%v, не прочитано %v",
		snap.CPUPercent, snap.Mem.UsedBytes, snap.Mem.TotalBytes, snap.Uptime,
		len(snap.Disks), snap.Valid, snap.Missing)

	projects, err := Discover(ctx, conn)
	if err != nil {
		t.Fatalf("обнаружение проектов: %v", err)
	}
	t.Logf("проектов найдено: %d", len(projects))

	counts := map[ProjectState]int{}
	for _, p := range projects {
		counts[p.State]++
	}
	t.Logf("по состояниям: работает=%d отработал=%d ждёт=%d запускается=%d лежит=%d",
		counts[StateRunning], counts[StateDone], counts[StateWaiting],
		counts[StateStarting], counts[StateDown])

	// Печатаем всё, что НЕ работает: именно там и живут ложные тревоги.
	shown := 0
	for _, p := range projects {
		if p.State == StateRunning || shown >= 14 {
			continue
		}
		shown++
		t.Logf("  [%s] %s %s | %s | триггер=%q", p.State, p.Kind, p.ID, p.Status, p.Trigger)
	}
}
