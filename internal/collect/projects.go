package collect

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

type ProjectKind string

const (
	KindDocker  ProjectKind = "docker"
	KindSystemd ProjectKind = "systemd"
)

type Project struct {
	Kind  ProjectKind
	ID    string       // имя контейнера или юнита
	Name  string       // отображаемое имя, по умолчанию равно ID
	State ProjectState // пять состояний, см. state.go
	// Trigger - чем юнит поднимается, когда придёт время: таймер или сокет.
	// Пусто у всех остальных. Без него подпись «ждёт» превращается в загадку:
	// человек видит простой и не понимает, простой чего именно.
	Trigger    string
	Status     string // человеческая строка от docker или systemd
	CPUPercent float64
	MemBytes   uint64
	// CPUKnown и MemKnown отличают ЗНАЧЕНИЕ от ОТСУТСТВИЯ значения.
	// Простаивающий контейнер честно потребляет 0.00%, и прочерк вместо нуля
	// говорит «не знаю» там, где мы знаем. У systemd загрузка к тому же
	// неизвестна до второго замера: дельту не с чем считать.
	CPUKnown bool
	MemKnown bool
	// FromPackage=true у юнитов из /lib и /usr/lib: по умолчанию скрыты.
	FromPackage bool
}

// Discover собирает полный список. Отсутствие docker это не ошибка: раздел
// контейнеров просто не появится.
func Discover(ctx context.Context, c transport.Conn) ([]Project, error) {
	var res []Project

	ps, err := c.Run(ctx, "docker ps -a --format json 2>/dev/null")
	if err != nil {
		return nil, err
	}
	if ps.Code == 0 {
		cs, err := ParseDockerPS(ps.Stdout)
		if err != nil {
			return nil, fmt.Errorf("разбор docker ps: %w", err)
		}
		// Переменная называется ct, а не c: имя c здесь затенило бы соединение,
		// и любая будущая правка внутри цикла молча потеряла бы доступ к нему.
		for _, ct := range cs {
			res = append(res, Project{
				Kind: KindDocker, ID: ct.Name, Name: ct.Name,
				State: ContainerState(ct.State, ct.Status), Status: ct.Status,
			})
		}
	}

	units, err := c.Run(ctx,
		"systemctl list-units --type=service --all --no-pager --no-legend --plain")
	if err != nil {
		return nil, err
	}
	if units.Code == 0 {
		us, err := ParseSystemctlUnits(units.Stdout)
		if err != nil {
			return nil, err
		}
		props, err := unitProperties(ctx, c, us)
		if err != nil {
			return nil, err
		}
		for _, u := range us {
			pr := props[u.Name]
			// Свойства из systemctl show точнее, чем колонки list-units:
			// колонок там всего две, а отличить отработавшего от упавшего без
			// Result невозможно в принципе.
			active, sub := valueOr(pr["ActiveState"], u.Active), valueOr(pr["SubState"], u.Sub)
			trigger := firstField(pr["TriggeredBy"])
			res = append(res, Project{
				Kind: KindSystemd, ID: u.Name, Name: u.Name,
				State:       UnitState(active, sub, pr["Result"], trigger),
				Trigger:     trigger,
				Status:      active + " / " + sub,
				FromPackage: !IsUserUnit(pr["FragmentPath"]),
			})
		}
	}

	return res, nil
}

// unitProperties спрашивает свойства одним вызовом на все юниты, а не по
// вызову на каждый: на сотне юнитов сто SSH-сессий это несколько секунд на
// пустом месте. Свойств пять, но команда по-прежнему одна.
func unitProperties(ctx context.Context, c transport.Conn, us []Unit) (map[string]map[string]string, error) {
	if len(us) == 0 {
		return map[string]map[string]string{}, nil
	}
	names := make([]string, 0, len(us))
	for _, u := range us {
		// Имена экранируются по тому же правилу, что и в Restarts: они приехали
		// с управляемого сервера, а значит доверенными не являются.
		names = append(names, shellQuoteArg(u.Name))
	}
	cmd := "systemctl show " + strings.Join(names, " ") +
		" --property=Id --property=FragmentPath --property=ActiveState" +
		" --property=SubState --property=Result --property=TriggeredBy"
	res, err := c.Run(ctx, cmd)
	if err != nil {
		return nil, err
	}

	return splitShowBlocks(res.Stdout), nil
}

// splitShowBlocks разбирает вывод `systemctl show` для НЕСКОЛЬКИХ юнитов.
//
// Опираться на разделение блоков пустой строкой нельзя: это поведение не
// зафиксировано и разнится между версиями systemd. Если разделителя не
// окажется, разбор вернул бы один блок, фильтр системных юнитов молча
// перестал бы работать, и первый экран превратился бы в свалку из полусотни
// служб - причём без единой ошибки в логах.
//
// Поэтому границу блока определяем по повтору ключа: встретили Id второй раз
// значит начался следующий юнит. Порядок ключей внутри блока при этом не важен.
func splitShowBlocks(out string) map[string]map[string]string {
	res := map[string]map[string]string{}
	cur := map[string]string{}

	flush := func() {
		if id := cur["Id"]; id != "" {
			res[id] = cur
		}
		cur = map[string]string{}
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		key, val := line[:i], line[i+1:]
		if _, seen := cur[key]; seen {
			flush()
		}
		cur[key] = val
	}
	flush()
	return res
}

// shellQuoteArg заворачивает аргумент в одинарные кавычки. Дубль такой же
// функции из пакета service намеренный: тащить один пакет в другой ради трёх
// строк дороже, чем повторить их.
func shellQuoteArg(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Restarts читает число перезапусков юнита за сутки. Здесь и пригождается
// ParseShowProperties: у одного юнита вывод systemctl show это простые пары
// KEY=VALUE, и городить splitShowBlocks незачем.
//
// У Docker бесплатного аналога нет: docker inspect отдаёт RestartCount за всё
// время жизни контейнера, а не за сутки, поэтому для контейнеров возвращается
// -1 и интерфейс показывает прочерк вместо выдуманного числа.
func Restarts(ctx context.Context, c transport.Conn, p Project) (int, error) {
	if p.Kind != KindSystemd {
		return -1, nil
	}
	res, err := c.Run(ctx, "systemctl show "+shellQuoteArg(p.ID)+" --property=NRestarts")
	if err != nil {
		return -1, err
	}
	props, err := ParseShowProperties(res.Stdout)
	if err != nil {
		return -1, err
	}
	v, err := strconv.Atoi(strings.TrimSpace(props["NRestarts"]))
	if err != nil {
		return -1, nil // свойства нет на старых systemd, это не ошибка
	}
	return v, nil
}

// StatsCollector считает потребление проектов. Такт отдельный от метрик хоста:
// docker stats тратит около секунды даже с --no-stream и в двухсекундный такт
// не укладывается. Предыдущие показания cgroup хранятся здесь, потому что
// CgroupCPUPercent работает только на разнице двух замеров.
type StatsCollector struct {
	// Ключ включает ID сервера: `nginx.service` и `bot.service` живут на любой
	// второй машине, и без этого дельта CPU считалась бы между замерами РАЗНЫХ
	// серверов. Цифры при этом получаются произвольные, вплоть до всплесков в
	// сотни процентов.
	prevCgroup map[string]uint64
	prevAt     map[string]time.Time
}

func NewStatsCollector() *StatsCollector {
	return &StatsCollector{
		prevCgroup: map[string]uint64{},
		prevAt:     map[string]time.Time{},
	}
}

func cgKey(serverID, id string) string { return serverID + "\x00" + id }

// Collect дополняет список проектов потреблением. Контейнеры берутся из
// docker stats одним вызовом, юниты - чтением cgroup по путям из
// ControlGroup. Проекты, для которых потребление недоступно (cgroup v1,
// остановленный контейнер), возвращаются с нулями, а не выпадают из списка.
func (s *StatsCollector) Collect(ctx context.Context, serverID string,
	c transport.Conn, projects []Project) ([]Project, error) {

	stats, err := c.Run(ctx, "docker stats --no-stream --format json 2>/dev/null")
	if err != nil {
		return nil, err
	}
	byName := map[string]ContainerStat{}
	if stats.Code == 0 {
		list, err := ParseDockerStats(stats.Stdout)
		if err != nil {
			return nil, err
		}
		for _, st := range list {
			byName[st.Name] = st
		}
	}

	now := time.Now()
	elapsed := 0.0
	if prev, ok := s.prevAt[serverID]; ok {
		elapsed = now.Sub(prev).Seconds()
	}

	cg, err := s.unitStats(ctx, c, projects)
	if err != nil {
		return nil, err
	}

	out := make([]Project, 0, len(projects))
	for _, p := range projects {
		switch p.Kind {
		case KindDocker:
			if st, ok := byName[p.ID]; ok {
				p.CPUPercent, p.MemBytes = st.CPUPercent, st.MemBytes
				p.CPUKnown, p.MemKnown = true, true
			}
		case KindSystemd:
			if u, ok := cg[p.ID]; ok {
				p.MemBytes, p.MemKnown = u.mem, true
				k := cgKey(serverID, p.ID)
				if elapsed > 0 {
					if prev, seen := s.prevCgroup[k]; seen {
						p.CPUPercent = CgroupCPUPercent(prev, u.usageUsec, elapsed)
						p.CPUKnown = true
					}
				}
				s.prevCgroup[k] = u.usageUsec
			}
		}
		out = append(out, p)
	}
	s.prevAt[serverID] = now
	return out, nil
}

type unitUsage struct {
	usageUsec uint64
	mem       uint64
}

// unitStats читает cgroup всех юнитов одной командой. Путь берётся из
// ControlGroup, файлы cpu.stat и memory.current лежат под /sys/fs/cgroup.
// Читается только cgroup v2: наличие проверяется по cgroup.controllers, на v1
// возвращается пустая карта и юниты показываются без цифр.
func (s *StatsCollector) unitStats(ctx context.Context, c transport.Conn,
	projects []Project) (map[string]unitUsage, error) {

	var names []string
	for _, p := range projects {
		// Спрашиваем cgroup только у тех, за кем есть живой процесс.
		// У отработавшего и ждущего там пусто, а команда была бы потрачена.
		if p.Kind == KindSystemd && p.State.HasProcess() {
			names = append(names, p.ID)
		}
	}
	if len(names) == 0 {
		return map[string]unitUsage{}, nil
	}

	// Скрипт печатает по блоку на юнит: имя, usage_usec, memory.current.
	// Отсутствующие файлы дают пустые значения, а не обрывают весь вывод.
	// Имена экранируются, хотя и приходят с управляемого сервера. Правило
	// «данные с сервера считаем доверенными» - это то, как обычно и приезжает
	// выполнение чужой команды: сервер могли уже скомпрометировать, и панель не
	// должна становиться вторым звеном.
	quoted := make([]string, 0, len(names))
	for _, n := range names {
		quoted = append(quoted, shellQuoteArg(n))
	}

	script := `[ -f /sys/fs/cgroup/cgroup.controllers ] || exit 0
for u in ` + strings.Join(quoted, " ") + `; do
  cg=$(systemctl show "$u" --property=ControlGroup --value 2>/dev/null)
  [ -n "$cg" ] || continue
  echo "UNIT $u"
  awk '/^usage_usec/{print "CPU " $2}' "/sys/fs/cgroup$cg/cpu.stat" 2>/dev/null
  echo "MEM $(cat "/sys/fs/cgroup$cg/memory.current" 2>/dev/null)"
done`

	res, err := c.Run(ctx, script)
	if err != nil {
		return nil, err
	}

	out := map[string]unitUsage{}
	cur := ""
	for _, line := range strings.Split(res.Stdout, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		switch f[0] {
		case "UNIT":
			cur = f[1]
		case "CPU":
			if cur != "" {
				u := out[cur]
				u.usageUsec, _ = strconv.ParseUint(f[1], 10, 64)
				out[cur] = u
			}
		case "MEM":
			if cur != "" {
				u := out[cur]
				u.mem, _ = strconv.ParseUint(f[1], 10, 64)
				out[cur] = u
			}
		}
	}
	return out, nil
}

// valueOr подставляет запасное значение, когда systemctl show не отдал
// свойство: на старых версиях и у экзотических юнитов часть полей пуста, а
// колонки list-units есть всегда.
func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// firstField берёт первый триггер из списка. TriggeredBy может перечислять и
// таймер, и сокет сразу; для подписи хватает одного, а показывать всё значит
// растянуть строку на пол-экрана.
func firstField(v string) string {
	f := strings.Fields(v)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}
