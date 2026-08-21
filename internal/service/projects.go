package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/diag"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
)

type ProjectDTO struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
	// State - одно из пяти значений collect.ProjectState. Булева «работает»
	// здесь больше нет: она сваливала отработавший oneshot, юнит по таймеру и
	// настоящий отказ в одну красную кучу.
	State string `json:"state"`
	// Trigger - таймер или сокет, которым юнит поднимается. Пусто у остальных.
	Trigger    string  `json:"trigger"`
	Status     string  `json:"status"`
	CPUPercent float64 `json:"cpuPercent"`
	MemBytes   uint64  `json:"memBytes"`
	// CPUKnown и MemKnown отличают ноль от «не знаем». Без них интерфейс
	// вынужден догадываться по значению, и честный 0.00% у простаивающего
	// контейнера превращается в прочерк.
	CPUKnown bool   `json:"cpuKnown"`
	MemKnown bool   `json:"memKnown"`
	Hidden   bool   `json:"hidden"`
	Health   string `json:"health"`
}

type ProjectsTick struct {
	ServerID string       `json:"serverId"`
	Projects []ProjectDTO `json:"projects"`
}

type ProjectsService struct {
	app   *application.App
	st    *store.Store
	conns *ConnRegistry
	stats *collect.StatsCollector
	mu    sync.Mutex
	stop  map[string]context.CancelFunc
	// failed помнит неудачный такт, чтобы сообщить об обратном переходе.
	// Иначе приглушённая шапка остаётся на экране навсегда: «замерло» шлётся,
	// а «отмерло» нет.
	failed map[string]bool
}

func NewProjectsService(app *application.App, st *store.Store,
	conns *ConnRegistry) *ProjectsService {
	return &ProjectsService{app: app, st: st, conns: conns,
		stats:  collect.NewStatsCollector(),
		stop:   map[string]context.CancelFunc{},
		failed: map[string]bool{}}
}

func (p *ProjectsService) Discover(serverID string) ([]ProjectDTO, error) {
	conn, err := p.conns.Get(serverID)
	if err != nil {
		return nil, err
	}
	raw, err := collect.Discover(context.Background(), conn)
	if err != nil {
		return nil, err
	}
	withStats, err := p.stats.Collect(context.Background(), serverID, conn, raw)
	if err != nil {
		return nil, err
	}
	return applyOverrides(withStats, p.st.Overrides(serverID)), nil
}

// Restarts отдаёт число перезапусков юнита. Это NRestarts из systemd, то есть
// счётчик автоматических перезапусков с момента последнего ручного старта, а
// НЕ «за сутки»: суточное число из systemd не достаётся вовсе, за ним пришлось
// бы разбирать журнал. У контейнеров возвращается -1, и интерфейс рисует
// прочерк вместо выдуманного числа.
func (p *ProjectsService) Restarts(serverID, projectID string,
	kind collect.ProjectKind) (int, error) {

	conn, err := p.conns.Get(serverID)
	if err != nil {
		return -1, err
	}
	return collect.Restarts(context.Background(), conn,
		collect.Project{Kind: kind, ID: projectID})
}

func (p *ProjectsService) SaveOverride(o store.ProjectOverride) error {
	return p.st.PutOverride(o)
}

// Start запускает такт проектов. Отдельный от метрик хоста и вдвое реже:
// docker stats тратит около секунды даже с --no-stream и в двухсекундный такт
// не укладывается. Без этого тикера константа projectsTick была бы объявлена и
// не использована, а спека раздела 7 требует именно отдельного такта.
func (p *ProjectsService) Start(serverID string) error {
	diag.Logf("ProjectsService.Start: сервер=%s", serverID)
	p.Stop(serverID)
	if _, err := p.conns.Get(serverID); err != nil {
		diag.Logf("ProjectsService.Start: ОТКАЗ, сервер=%s: %v", serverID, err)
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	p.mu.Lock()
	p.stop[serverID] = cancel
	p.mu.Unlock()

	go func() {
		ticks := 0
		t := time.NewTicker(projectsTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				list, err := p.Discover(serverID)
				if err != nil {
					diag.Logf("projects: такт не удался, сервер=%s: %v", serverID, err)
					// Молчать нельзя по той же причине, что и в метриках:
					// застывший список выглядит живым.
					p.mu.Lock()
					p.failed[serverID] = true
					p.mu.Unlock()
					p.app.Event.Emit("conn:state", ConnStateEvent{
						ServerID: serverID, State: "degraded", Message: err.Error(),
					})
					continue
				}
				p.mu.Lock()
				was := p.failed[serverID]
				delete(p.failed, serverID)
				p.mu.Unlock()
				if was {
					// Такт снова проходит. Без этого сообщения интерфейс
					// остаётся приглушённым при живых данных.
					p.app.Event.Emit("conn:state", ConnStateEvent{
						ServerID: serverID, State: "connected",
					})
				}
				ticks++
				if ticks <= 3 || ticks%12 == 0 {
					diag.Logf("projects:tick #%d сервер=%s проектов=%d",
						ticks, serverID, len(list))
				}
				p.app.Event.Emit("projects:tick", ProjectsTick{
					ServerID: serverID, Projects: list,
				})
			}
		}
	}()
	return nil
}

func (p *ProjectsService) Stop(serverID string) {
	diag.Logf("ProjectsService.Stop: сервер=%s", serverID)
	p.mu.Lock()
	cancel, ok := p.stop[serverID]
	delete(p.stop, serverID)
	p.mu.Unlock()
	if ok {
		cancel()
	}
}

// applyOverrides накладывает пользовательские настройки на сырой список.
// Обнаружение остаётся источником правды о том, что есть на сервере;
// настройки решают только как это показать.
func applyOverrides(projects []collect.Project,
	ov map[string]store.ProjectOverride) []ProjectDTO {

	out := make([]ProjectDTO, 0, len(projects))
	for _, p := range projects {
		dto := ProjectDTO{
			Kind: string(p.Kind), ID: p.ID, Name: p.Name,
			State: string(p.State), Trigger: p.Trigger, Status: p.Status,
			CPUKnown: p.CPUKnown, MemKnown: p.MemKnown,
			CPUPercent: p.CPUPercent, MemBytes: p.MemBytes,
			// Юниты из пакетов скрыты по умолчанию, но явная настройка
			// сильнее умолчания в обе стороны.
			Hidden: p.FromPackage,
		}
		if o, ok := ov[string(p.Kind)+":"+p.ID]; ok {
			if o.Label != "" {
				dto.Name = o.Label
			}
			dto.Hidden = o.Hidden
			dto.Health = o.Health
		}
		out = append(out, dto)
	}
	return out
}

// Разрешённые действия перечислены явно. Подставлять сюда произвольную строку
// с фронта нельзя: это прямая дорога к выполнению чужой команды на сервере.
var allowedActions = map[string]bool{"start": true, "stop": true, "restart": true}

func (p *ProjectsService) Action(serverID, projectID string,
	kind collect.ProjectKind, action string) error {

	if !allowedActions[action] {
		return fmt.Errorf("недопустимое действие %q", action)
	}
	conn, err := p.conns.Get(serverID)
	if err != nil {
		return err
	}
	cmd := "docker " + action + " " + shellQuote(projectID)
	if kind == collect.KindSystemd {
		cmd = "systemctl " + action + " " + shellQuote(projectID)
	}
	res, err := conn.Run(context.Background(), cmd)
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return fmt.Errorf("%s: %s", action, strings.TrimSpace(res.Stderr))
	}
	return nil
}
