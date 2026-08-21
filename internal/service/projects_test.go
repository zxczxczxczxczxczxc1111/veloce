package service

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

type recordingConn struct {
	cmds []string
	res  transport.Result
}

func (r *recordingConn) Run(_ context.Context, cmd string) (transport.Result, error) {
	r.cmds = append(r.cmds, cmd)
	return r.res, nil
}

func (r *recordingConn) Stream(context.Context, string) (io.ReadCloser, error) { return nil, nil }
func (r *recordingConn) State() transport.State                                { return transport.StateConnected }
func (r *recordingConn) SetStateHook(func(transport.State))                    {}
func (r *recordingConn) Close() error                                          { return nil }

func TestApplyOverridesHidesPackageUnitsByDefault(t *testing.T) {
	projects := []collect.Project{
		{Kind: collect.KindSystemd, ID: "nginx.service", Name: "nginx.service", FromPackage: true},
		{Kind: collect.KindSystemd, ID: "bot.service", Name: "bot.service"},
	}
	got := applyOverrides(projects, map[string]store.ProjectOverride{})
	if !got[0].Hidden {
		t.Fatal("юнит из пакета обязан быть скрыт по умолчанию")
	}
	if got[1].Hidden {
		t.Fatal("свой юнит скрывать нечего")
	}
}

func TestApplyOverridesBeatsDefaultInBothDirections(t *testing.T) {
	projects := []collect.Project{
		{Kind: collect.KindSystemd, ID: "nginx.service", Name: "nginx.service", FromPackage: true},
		{Kind: collect.KindDocker, ID: "web", Name: "web"},
	}
	ov := map[string]store.ProjectOverride{
		// Пакетный юнит показать явно.
		"systemd:nginx.service": {Kind: "systemd", ID: "nginx.service", Hidden: false, Label: "Вебсервер"},
		// Свой контейнер спрятать явно.
		"docker:web": {Kind: "docker", ID: "web", Hidden: true},
	}
	got := applyOverrides(projects, ov)
	if got[0].Hidden {
		t.Fatal("явная настройка не пересилила умолчание про пакетные юниты")
	}
	if got[0].Name != "Вебсервер" {
		t.Fatalf("имя не подменилось: %q", got[0].Name)
	}
	if !got[1].Hidden {
		t.Fatal("явное скрытие контейнера не применилось")
	}
}

func TestApplyOverridesDoesNotMixKinds(t *testing.T) {
	// Настройка контейнера nginx не должна прилипнуть к юниту nginx.
	projects := []collect.Project{{Kind: collect.KindSystemd, ID: "nginx", Name: "nginx"}}
	ov := map[string]store.ProjectOverride{
		"docker:nginx": {Kind: "docker", ID: "nginx", Label: "чужое имя"},
	}
	got := applyOverrides(projects, ov)
	if got[0].Name != "nginx" {
		t.Fatalf("настройка контейнера уехала на юнит: %q", got[0].Name)
	}
}

func TestActionRejectsAnythingButThreeVerbs(t *testing.T) {
	conns := NewConnRegistry()
	c := &recordingConn{}
	conns.Set("s1", c)
	p := &ProjectsService{conns: conns}

	for _, bad := range []string{"rm", "", "restart; rm -rf /", "RESTART"} {
		if err := p.Action("s1", "web", collect.KindDocker, bad); err == nil {
			t.Fatalf("действие %q проехало", bad)
		}
	}
	if len(c.cmds) != 0 {
		t.Fatalf("на сервер ушла команда: %+v", c.cmds)
	}
}

func TestActionQuotesProjectID(t *testing.T) {
	conns := NewConnRegistry()
	c := &recordingConn{}
	conns.Set("s1", c)
	p := &ProjectsService{conns: conns}

	if err := p.Action("s1", "web; rm -rf /", collect.KindDocker, "restart"); err != nil {
		t.Fatalf("Action: %v", err)
	}
	if len(c.cmds) != 1 {
		t.Fatalf("команд %d", len(c.cmds))
	}
	if !strings.Contains(c.cmds[0], `'web; rm -rf /'`) {
		t.Fatalf("имя проекта ушло без кавычек: %q", c.cmds[0])
	}
}

func TestActionUsesSystemctlForUnits(t *testing.T) {
	conns := NewConnRegistry()
	c := &recordingConn{}
	conns.Set("s1", c)
	p := &ProjectsService{conns: conns}

	if err := p.Action("s1", "bot.service", collect.KindSystemd, "stop"); err != nil {
		t.Fatalf("Action: %v", err)
	}
	if !strings.HasPrefix(c.cmds[0], "systemctl stop ") {
		t.Fatalf("команда %q", c.cmds[0])
	}
}

func TestActionReportsNonZeroCode(t *testing.T) {
	conns := NewConnRegistry()
	conns.Set("s1", &recordingConn{res: transport.Result{Code: 5, Stderr: "нет такого юнита\n"}})
	p := &ProjectsService{conns: conns}

	err := p.Action("s1", "bot.service", collect.KindSystemd, "start")
	if err == nil {
		t.Fatal("ненулевой код возврата проглочен")
	}
	if !strings.Contains(err.Error(), "нет такого юнита") {
		t.Fatalf("текст ошибки потерян: %v", err)
	}
}

func TestConnRegistryClosesReplaced(t *testing.T) {
	r := NewConnRegistry()
	old := &closableConn{}
	r.Set("s1", old)
	r.Set("s1", &closableConn{})
	// Иначе переподключение оставляет висеть предыдущую сессию на сервере.
	if !old.closed {
		t.Fatal("прежнее соединение не закрыли при замене")
	}
}

func TestConnRegistryErrsOnUnknownServer(t *testing.T) {
	if _, err := NewConnRegistry().Get("нет такого"); err == nil {
		t.Fatal("реестр отдал соединение к несуществующему серверу")
	}
}

type closableConn struct {
	recordingConn
	closed bool
}

func (c *closableConn) Close() error { c.closed = true; return nil }

func TestStateNameCoversEveryState(t *testing.T) {
	// Фронт разбирает эти строки switch-ем. Молчаливое «disconnected» вместо
	// настоящей причины отправляет чинить не то звено.
	cases := map[transport.State]string{
		transport.StateDisconnected:   "disconnected",
		transport.StateConnecting:     "connecting",
		transport.StateConnected:      "connected",
		transport.StateAuthFailed:     "authFailed",
		transport.StateHostKeyUnknown: "hostKeyUnknown",
		transport.StateJumpFailed:     "jumpFailed",
	}
	for st, want := range cases {
		if got := stateName(st); got != want {
			t.Fatalf("состояние %d дало %q, ожидалось %q", st, got, want)
		}
	}
}
