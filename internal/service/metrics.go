package service

import (
	"context"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
)

// Такты разные намеренно: docker stats тратит около секунды даже с --no-stream
// и в двухсекундный такт не укладывается.
const (
	hostTick     = 2 * time.Second
	projectsTick = 5 * time.Second
)

type MetricsTick struct {
	ServerID   string    `json:"serverId"`
	CPUPercent float64   `json:"cpuPercent"`
	MemUsed    uint64    `json:"memUsed"`
	MemTotal   uint64    `json:"memTotal"`
	Disks      []DiskDTO `json:"disks"`
	RxPerSec   float64   `json:"rxPerSec"`
	TxPerSec   float64   `json:"txPerSec"`
	UptimeSec  int64     `json:"uptimeSec"`
	// Valid=false у первого такта. Интерфейс обязан это уважать и не рисовать
	// значение: дельту не с чем считать, и число было бы враньём.
	Valid bool `json:"valid"`
	// Missing перечисляет метрики, которые не удалось прочитать на этом такте
	// ("cpu", "memory", "disk", "net", "uptime"). Интерфейс рисует по ним
	// прочерк. Без этого поля недоступная метрика приезжала бы нулём и
	// выглядела бы как «нагрузки нет», что прямо противоположно правде.
	Missing []string `json:"missing"`
}

type DiskDTO struct {
	Mount string `json:"mount"`
	Used  uint64 `json:"used"`
	Size  uint64 `json:"size"`
}

type MetricsService struct {
	app   *application.App
	conns *ConnRegistry
	mu    sync.Mutex
	stop  map[string]context.CancelFunc
	// failed помнит, что прошлый такт не удался. Нужен, чтобы сообщить об
	// ОБРАТНОМ переходе: без этого приглушённая шапка и подпись «данные от
	// 14:32» остаются на экране навсегда, хотя цифры давно снова живые.
	failed map[string]bool
}

func NewMetricsService(app *application.App, conns *ConnRegistry) *MetricsService {
	return &MetricsService{app: app, conns: conns,
		stop:   map[string]context.CancelFunc{},
		failed: map[string]bool{}}
}

func (m *MetricsService) Start(serverID string) error {
	m.Stop(serverID)
	// Проверяем наличие соединения один раз, чтобы Start честно вернул ошибку
	// на несуществующем сервере. Внутри такта соединение берётся заново.
	if _, err := m.conns.Get(serverID); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.stop[serverID] = cancel
	m.mu.Unlock()

	go func() {
		hc := collect.NewHostCollector()
		t := time.NewTicker(hostTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// Соединение берётся из реестра НА КАЖДОМ такте, а не
				// захватывается один раз при запуске. Захваченная ссылка после
				// переподключения указывала бы на закрытое соединение, и тикер
				// молча умирал бы навсегда.
				c, err := m.conns.Get(serverID)
				if err != nil {
					m.fail(serverID, err)
					continue
				}
				snap, err := hc.Collect(ctx, c)
				if err != nil {
					// Ошибку НЕ глотаем. Молчаливый continue оставляет на
					// экране застывшие цифры, которые выглядят живыми, - это
					// худший из возможных отказов для панели наблюдения.
					m.fail(serverID, err)
					continue
				}
				m.recovered(serverID)
				m.app.Event.Emit("metrics:tick", toTick(serverID, snap))
			}
		}
	}()
	return nil
}

// fail сообщает интерфейсу, что такт не удался. Интерфейс на это приглушает
// шапку и подписывает время последнего успешного замера.
func (m *MetricsService) fail(serverID string, err error) {
	m.mu.Lock()
	m.failed[serverID] = true
	m.mu.Unlock()
	m.app.Event.Emit("conn:state", ConnStateEvent{
		ServerID: serverID, State: "degraded", Message: err.Error(),
	})
}

// recovered сообщает, что такт снова проходит. Отправляется ТОЛЬКО после
// неудачи: слать «на связи» на каждом такте значит забивать шину событий два
// раза в секунду ради ничего.
func (m *MetricsService) recovered(serverID string) {
	m.mu.Lock()
	was := m.failed[serverID]
	delete(m.failed, serverID)
	m.mu.Unlock()
	if was {
		m.app.Event.Emit("conn:state", ConnStateEvent{
			ServerID: serverID, State: "connected",
		})
	}
}

func (m *MetricsService) Stop(serverID string) {
	m.mu.Lock()
	cancel, ok := m.stop[serverID]
	delete(m.stop, serverID)
	m.mu.Unlock()
	if ok {
		cancel()
	}
}

func toTick(serverID string, s collect.HostSnapshot) MetricsTick {
	disks := make([]DiskDTO, 0, len(s.Disks))
	for _, d := range s.Disks {
		disks = append(disks, DiskDTO{Mount: d.Mount, Used: d.UsedBytes, Size: d.SizeBytes})
	}
	missing := s.Missing
	if missing == nil {
		// Пустой срез, а не nil: в JSON nil становится null, и фронту пришлось
		// бы проверять на него отдельно перед каждым includes.
		missing = []string{}
	}
	return MetricsTick{
		ServerID: serverID, CPUPercent: s.CPUPercent,
		MemUsed: s.Mem.UsedBytes, MemTotal: s.Mem.TotalBytes,
		Disks: disks, RxPerSec: s.RxPerSec, TxPerSec: s.TxPerSec,
		UptimeSec: int64(s.Uptime.Seconds()), Valid: s.Valid,
		Missing: missing,
	}
}
