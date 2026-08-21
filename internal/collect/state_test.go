package collect

import "testing"

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
