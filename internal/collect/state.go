package collect

import (
	"strconv"
	"strings"
)

// ProjectState - состояние проекта в терминах человека, а не systemd.
//
// Двух состояний не хватает: юнит по таймеру между запусками, отработавший
// oneshot и запускающийся прямо сейчас это НЕ поломка, а красная точка на
// каждом из них приучает не смотреть на красное вообще. После этого панель
// наблюдения теряет весь смысл.
type ProjectState string

const (
	StateRunning  ProjectState = "running"  // есть живой процесс
	StateDone     ProjectState = "done"     // отработал и завершился штатно
	StateWaiting  ProjectState = "waiting"  // ждёт таймера, сокета или запуска
	StateStarting ProjectState = "starting" // переходное состояние
	StateDown     ProjectState = "down"     // отказ или остановлен
)

// HasProcess отвечает, есть ли смысл спрашивать потребление. У отработавшего
// и ждущего процесса нет: cgroup отдаст пустоту, а команда будет потрачена.
func (s ProjectState) HasProcess() bool { return s == StateRunning }

// UnitState разбирает состояние юнита systemd.
//
// Порядок проверок важен. Result сверяется раньше ActiveState: юнит по
// таймеру, чей последний запуск свалился, выглядит как inactive/dead ровно так
// же, как успешно отработавший, и отличает их только Result.
func UnitState(active, sub, result, triggeredBy string) ProjectState {
	switch {
	case active == "failed" || sub == "failed":
		return StateDown
	case result != "" && result != "success":
		return StateDown
	case active == "activating" || active == "deactivating":
		// Остановка тоже переходное состояние. Шестой подписи ради двух секунд
		// не заводим, но красной она быть не должна.
		return StateStarting
	case active == "active" && sub == "running":
		return StateRunning
	case active == "active":
		// active/exited: oneshot сделал дело и завершился. Юнит числится
		// активным, но процесса за ним нет.
		return StateDone
	case triggeredBy != "":
		// Спит до таймера или до обращения в сокет. Это штатная жизнь такого
		// юнита, а не простой.
		return StateWaiting
	default:
		return StateDown
	}
}

// ContainerState разбирает состояние контейнера docker.
//
// Отличить «остановлен» от «поднимается по запросу» docker не позволяет: он
// про сокет-активацию снаружи ничего не знает. Поэтому решает код выхода: ноль
// это сделанная работа, всё остальное это падение.
func ContainerState(state, status string) ProjectState {
	switch state {
	case "running":
		return StateRunning
	case "restarting":
		return StateStarting
	case "created":
		return StateWaiting
	case "exited":
		code, ok := exitCode(status)
		if ok && code == 0 {
			return StateDone
		}
		// Кода в строке может не быть вовсе (старый docker, чужая локаль).
		// Догадываться нельзя: ложное «отработал» прячет упавший контейнер.
		return StateDown
	default:
		// paused, dead и всё, чего мы не знаем. Пауза это не работа.
		return StateDown
	}
}

// exitCode достаёт код из строки вида "Exited (137) 8 days ago".
func exitCode(status string) (int, bool) {
	open := strings.Index(status, "(")
	if open < 0 {
		return 0, false
	}
	close := strings.Index(status[open:], ")")
	if close < 0 {
		return 0, false
	}
	code, err := strconv.Atoi(strings.TrimSpace(status[open+1 : open+close]))
	if err != nil {
		return 0, false
	}
	return code, true
}
