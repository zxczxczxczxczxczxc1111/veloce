package collect

import (
	"context"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

func TestUnitStateFromSystemdProperties(t *testing.T) {
	cases := []struct {
		name        string
		active      string
		sub         string
		result      string
		triggeredBy string
		want        ProjectState
	}{
		{"крутится", "active", "running", "success", "", StateRunning},
		// oneshot, отработавший при загрузке. Он ЖИВ, но процесса нет: зелёный
		// сказал бы «работает прямо сейчас», а это неправда.
		{"отработал", "active", "exited", "success", "", StateDone},
		// Юнит по таймеру между запусками. Красный здесь означал бы поломку
		// там, где всё идёт ровно по расписанию.
		{"ждёт таймера", "inactive", "dead", "success", "docker-prune.timer", StateWaiting},
		{"ждёт сокета", "inactive", "dead", "success", "lt-ondemand.socket", StateWaiting},
		{"запускается", "activating", "start", "success", "", StateStarting},
		// Остановка это переходное состояние на пару секунд. Шестой подписи
		// ради него не заводим, но и красным звать его нельзя.
		{"останавливается", "deactivating", "stop", "success", "", StateStarting},
		{"упал", "failed", "failed", "exit-code", "", StateDown},
		// Result важнее ActiveState: юнит по таймеру, чей запуск свалился,
		// это отказ, а не «ждёт следующего раза».
		{"таймер, но прошлый запуск упал", "inactive", "dead", "exit-code",
			"backup.timer", StateDown},
		{"просто остановлен", "inactive", "dead", "success", "", StateDown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := UnitState(c.active, c.sub, c.result, c.triggeredBy)
			if got != c.want {
				t.Fatalf("состояние %q, ожидалось %q", got, c.want)
			}
		})
	}
}

func TestContainerStateFromDockerFields(t *testing.T) {
	cases := []struct {
		name   string
		state  string
		status string
		want   ProjectState
	}{
		{"работает", "running", "Up 2 hours", StateRunning},
		{"работает и здоров", "running", "Up 2 hours (healthy)", StateRunning},
		// Ноль это «задача сделана», всё остальное это «упало».
		{"вышел штатно", "exited", "Exited (0) 3 days ago", StateDone},
		{"убит", "exited", "Exited (137) 8 days ago", StateDown},
		{"упал с ошибкой", "exited", "Exited (1) 2 minutes ago", StateDown},
		{"перезапускается", "restarting", "Restarting (1) 5 seconds ago", StateStarting},
		{"создан, но не запускался", "created", "Created", StateWaiting},
		{"на паузе", "paused", "Up 3 hours (Paused)", StateDown},
		// Кода выхода в строке может не быть вовсе: старый docker, чужая
		// локаль. Догадываться нельзя, отказ безопаснее ложного «отработал».
		{"без кода выхода", "exited", "Exited", StateDown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ContainerState(c.state, c.status)
			if got != c.want {
				t.Fatalf("состояние %q, ожидалось %q", got, c.want)
			}
		})
	}
}

func TestRunningOnlyForActuallyRunning(t *testing.T) {
	// Потребление снимается только у того, у кого есть живой процесс. Спросив
	// cgroup у отработавшего юнита, мы получим пустоту и потратим команду.
	if !StateRunning.HasProcess() {
		t.Fatal("работающий обязан считаться живым")
	}
	for _, s := range []ProjectState{StateDone, StateWaiting, StateDown} {
		if s.HasProcess() {
			t.Fatalf("%q не имеет процесса, а считается живым", s)
		}
	}
}

func TestKnownFlagsSeparateZeroFromNoData(t *testing.T) {
	// Ноль это ЗНАЧЕНИЕ: простаивающий контейнер честно потребляет 0.00%.
	// Прочерк это ОТСУТСТВИЕ значения. Показав прочерк вместо нуля, панель
	// говорит «не знаю» там, где знает, и человек идёт искать несуществующую
	// поломку.
	projects := []Project{
		{Kind: KindDocker, ID: "idle", State: StateRunning},
		{Kind: KindDocker, ID: "gone", State: StateDown},
	}
	c := &scriptedConn{replies: map[string]transport.Result{
		"docker stats": {Stdout: `{"Name":"idle","CPUPerc":"0.00%","MemUsage":"162.2MiB / 3.8GiB"}` + "\n"},
		// Юнитов нет, значит cgroup-скрипт не вызывается вовсе.
		"cgroup.controllers": {Code: 127},
	}}

	got, err := NewStatsCollector().Collect(context.Background(), "srv1", c, projects)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	byID := map[string]Project{}
	for _, p := range got {
		byID[p.ID] = p
	}

	idle := byID["idle"]
	if !idle.CPUKnown || !idle.MemKnown {
		t.Fatalf("статистика простаивающего контейнера потеряна: %+v", idle)
	}
	if idle.CPUPercent != 0 {
		t.Fatalf("загрузка %v, ожидался честный ноль", idle.CPUPercent)
	}

	gone := byID["gone"]
	if gone.CPUKnown || gone.MemKnown {
		t.Fatalf("у контейнера без строки в docker stats цифры взялись из ниоткуда: %+v", gone)
	}
}

func TestSystemdCPUUnknownUntilSecondSample(t *testing.T) {
	projects := []Project{{Kind: KindSystemd, ID: "bot.service", State: StateRunning}}
	c := &scriptedConn{replies: map[string]transport.Result{
		"docker stats":       {Code: 127},
		"cgroup.controllers": {Stdout: "UNIT bot.service\nCPU 1000000\nMEM 536870912\n"},
	}}

	s := NewStatsCollector()
	first, err := s.Collect(context.Background(), "srv1", c, projects)
	if err != nil {
		t.Fatalf("первый Collect: %v", err)
	}
	// Память известна сразу, а загрузку не с чем сравнивать: дельты ещё нет.
	// Ноль здесь был бы враньём, поэтому именно «не знаю».
	if !first[0].MemKnown {
		t.Fatal("память с первого замера обязана быть известна")
	}
	if first[0].CPUKnown {
		t.Fatal("на первом замере загрузка не может быть известна")
	}

	c.replies["cgroup.controllers"] = transport.Result{
		Stdout: "UNIT bot.service\nCPU 2000000\nMEM 536870912\n",
	}
	s.prevAt["srv1"] = time.Now().Add(-2 * time.Second)

	second, err := s.Collect(context.Background(), "srv1", c, projects)
	if err != nil {
		t.Fatalf("второй Collect: %v", err)
	}
	if !second[0].CPUKnown {
		t.Fatal("на втором замере загрузка обязана быть известна")
	}
}
