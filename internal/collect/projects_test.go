package collect

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// scriptedConn отвечает по подстроке команды. Discover шлёт три разные команды,
// и одного заготовленного ответа на все ему мало.
type scriptedConn struct {
	replies map[string]transport.Result
	seen    []string
}

func (s *scriptedConn) Run(_ context.Context, cmd string) (transport.Result, error) {
	s.seen = append(s.seen, cmd)
	for key, res := range s.replies {
		if strings.Contains(cmd, key) {
			return res, nil
		}
	}
	// Ненайденная команда это код 127, ровно как у оболочки на unknown command.
	return transport.Result{Code: 127}, nil
}

func (s *scriptedConn) Stream(context.Context, string) (io.ReadCloser, error) { return nil, nil }
func (s *scriptedConn) State() transport.State                                { return transport.StateConnected }
func (s *scriptedConn) SetStateHook(func(transport.State))                    {}
func (s *scriptedConn) Close() error                                          { return nil }

// Вывод systemctl show для двух юнитов БЕЗ пустой строки между блоками. Именно
// этот случай и ломал разбор по пустым строкам.
const showBlocksGlued = `Id=bot.service
FragmentPath=/etc/systemd/system/bot.service
Id=nginx.service
FragmentPath=/lib/systemd/system/nginx.service
`

func TestSplitShowBlocksWithoutBlankLines(t *testing.T) {
	got := splitShowBlocks(showBlocksGlued)
	if len(got) != 2 {
		t.Fatalf("разобрано %d блоков, ожидалось 2: %+v", len(got), got)
	}
	if got["bot.service"]["FragmentPath"] != "/etc/systemd/system/bot.service" {
		t.Fatalf("bot.service: %q", got["bot.service"]["FragmentPath"])
	}
	if got["nginx.service"]["FragmentPath"] != "/lib/systemd/system/nginx.service" {
		t.Fatalf("nginx.service: %q", got["nginx.service"]["FragmentPath"])
	}
}

func TestSplitShowBlocksIgnoresOrder(t *testing.T) {
	// FragmentPath перед Id: границу определяет повтор ключа, а не позиция.
	out := "FragmentPath=/etc/systemd/system/a.service\nId=a.service\n" +
		"FragmentPath=/lib/systemd/system/b.service\nId=b.service\n"
	got := splitShowBlocks(out)
	if len(got) != 2 {
		t.Fatalf("разобрано %d блоков: %+v", len(got), got)
	}
}

func TestDiscoverSplitsUserAndPackageUnits(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{
		"docker ps":     {Stdout: dockerPSFixture},
		"list-units":    {Stdout: "bot.service loaded active running Discord bot\nnginx.service loaded active running web\n"},
		"--property=Id": {Stdout: showBlocksGlued},
	}}

	got, err := Discover(context.Background(), c)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	// Два контейнера плюс два юнита.
	if len(got) != 4 {
		t.Fatalf("получено %d проектов: %+v", len(got), got)
	}

	byID := map[string]Project{}
	for _, p := range got {
		byID[p.ID] = p
	}
	if byID["bot.service"].FromPackage {
		t.Fatal("юнит из /etc помечен пакетным")
	}
	if !byID["nginx.service"].FromPackage {
		t.Fatal("юнит из /lib не помечен пакетным, он утонет в списке вместе с нужными")
	}
	if byID["demo-app"].State != StateRunning {
		t.Fatalf("работающий контейнер разобран как %q", byID["demo-app"].State)
	}
	if byID["demo-worker"].State == StateRunning {
		t.Fatalf("остановленный контейнер разобран как работающий: %+v", got)
	}
}

func TestDiscoverSurvivesMissingDocker(t *testing.T) {
	// Docker нет: команда вернула 127. Юниты обязаны собраться всё равно.
	c := &scriptedConn{replies: map[string]transport.Result{
		"list-units":    {Stdout: "bot.service loaded active running Discord bot\n"},
		"--property=Id": {Stdout: "Id=bot.service\nFragmentPath=/etc/systemd/system/bot.service\n"},
	}}

	got, err := Discover(context.Background(), c)
	if err != nil {
		t.Fatalf("отсутствие docker не ошибка: %v", err)
	}
	if len(got) != 1 || got[0].ID != "bot.service" {
		t.Fatalf("получено %+v", got)
	}
}

func TestDiscoverQuotesUnitNames(t *testing.T) {
	// Имя юнита приезжает с управляемого сервера и доверенным не является.
	c := &scriptedConn{replies: map[string]transport.Result{
		"list-units":    {Stdout: "a b.service loaded active running x\n"},
		"--property=Id": {Stdout: ""},
	}}
	if _, err := Discover(context.Background(), c); err != nil {
		t.Fatalf("Discover: %v", err)
	}
	for _, cmd := range c.seen {
		if strings.Contains(cmd, "--property=Id") && !strings.Contains(cmd, "'b.service'") {
			t.Fatalf("имя юнита ушло в команду без кавычек: %q", cmd)
		}
	}
}

func TestStatsCollectorNeedsTwoSamples(t *testing.T) {
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
	// Первый замер: память уже есть, а загрузки быть не может, дельты нет.
	if first[0].MemBytes != 536870912 {
		t.Fatalf("память %d", first[0].MemBytes)
	}
	if first[0].CPUPercent != 0 {
		t.Fatalf("на первом замере загрузка обязана быть нулевой, получено %v", first[0].CPUPercent)
	}

	c.replies["cgroup.controllers"] = transport.Result{
		Stdout: "UNIT bot.service\nCPU 2000000\nMEM 536870912\n",
	}
	// Отматываем момент прошлого замера на две секунды назад вместо ожидания.
	// Без этого тест зависит от разрешения часов: на Windows два вызова
	// time.Now подряд дают одно и то же значение, elapsed выходит нулевым и
	// загрузка честно остаётся нулевой.
	s.prevAt["srv1"] = time.Now().Add(-2 * time.Second)

	second, err := s.Collect(context.Background(), "srv1", c, projects)
	if err != nil {
		t.Fatalf("второй Collect: %v", err)
	}
	if second[0].CPUPercent <= 0 {
		t.Fatalf("на втором замере ожидалась ненулевая загрузка, получено %v", second[0].CPUPercent)
	}
}

func TestStatsCollectorSeparatesServers(t *testing.T) {
	// Один и тот же юнит на двух серверах: дельта не должна считаться между
	// замерами разных машин.
	projects := []Project{{Kind: KindSystemd, ID: "bot.service", State: StateRunning}}
	c := &scriptedConn{replies: map[string]transport.Result{
		"docker stats":       {Code: 127},
		"cgroup.controllers": {Stdout: "UNIT bot.service\nCPU 5000000\nMEM 100\n"},
	}}

	s := NewStatsCollector()
	if _, err := s.Collect(context.Background(), "srv1", c, projects); err != nil {
		t.Fatalf("srv1: %v", err)
	}
	c.replies["cgroup.controllers"] = transport.Result{Stdout: "UNIT bot.service\nCPU 10\nMEM 100\n"}
	// У srv2 такт как будто уже был: без этого elapsed равен нулю и тест
	// прошёл бы вообще не проверяя разделение серверов.
	s.prevAt["srv2"] = time.Now().Add(-2 * time.Second)

	got, err := s.Collect(context.Background(), "srv2", c, projects)
	if err != nil {
		t.Fatalf("srv2: %v", err)
	}
	if got[0].CPUPercent != 0 {
		t.Fatalf("загрузка посчиталась между разными серверами: %v", got[0].CPUPercent)
	}
}

func TestRestartsIsDashForContainers(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{}}
	got, err := Restarts(context.Background(), c, Project{Kind: KindDocker, ID: "x"})
	if err != nil {
		t.Fatalf("Restarts: %v", err)
	}
	// -1 значит «показать прочерк», а не «ноль перезапусков».
	if got != -1 {
		t.Fatalf("получено %d, ожидалось -1", got)
	}
}

func TestRestartsReadsNRestarts(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{
		"NRestarts": {Stdout: "NRestarts=3\n"},
	}}
	got, err := Restarts(context.Background(), c, Project{Kind: KindSystemd, ID: "bot.service"})
	if err != nil {
		t.Fatalf("Restarts: %v", err)
	}
	if got != 3 {
		t.Fatalf("получено %d, ожидалось 3", got)
	}
}
