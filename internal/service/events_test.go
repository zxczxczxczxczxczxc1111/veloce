package service

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/collect"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// scriptedConn отвечает по подстроке команды: за такт уходит несколько разных
// команд, и одним ответом на всё их не проверить.
type scriptedConn struct {
	replies map[string]transport.Result
	seen    []string
}

func (c *scriptedConn) Run(_ context.Context, cmd string) (transport.Result, error) {
	c.seen = append(c.seen, cmd)
	for key, res := range c.replies {
		if strings.Contains(cmd, key) {
			return res, nil
		}
	}
	return transport.Result{Code: 127}, nil
}

func (c *scriptedConn) Stream(context.Context, string) (io.ReadCloser, error) { return nil, nil }
func (c *scriptedConn) State() transport.State                                { return transport.StateConnected }
func (c *scriptedConn) SetStateHook(func(transport.State))                    {}
func (c *scriptedConn) Close() error                                          { return nil }

func jailStatus(totalFailed, totalBanned int, ips string) transport.Result {
	return transport.Result{Stdout: fmt.Sprintf(`Status for the jail: sshd
|- Filter
|  |- Currently failed:	1
|  |- Total failed:	%d
`+"`"+`- Actions
   |- Currently banned:	1
   |- Total banned:	%d
   `+"`"+`- Banned IP list:	%s
`, totalFailed, totalBanned, ips)}
}

func newEvents(t *testing.T, c transport.Conn) (*EventsService, *sourceState) {
	t.Helper()
	es, err := store.OpenIncidents(filepath.Join(t.TempDir(), "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	reg := NewConnRegistry()
	reg.Set("srv1", c)
	// app здесь nil: детекторы событий не шлют, событие отправляет tick, а его
	// мы не вызываем.
	svc := NewEventsService(nil, reg, es)
	st := &sourceState{jails: map[string]collect.JailStatus{}}
	svc.prev["srv1"] = st
	return svc, st
}

func TestFirstTickOnlyRemembers(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{
		"fail2ban-client status 2>":  {Stdout: "Status\n`- Jail list:\tsshd\n"},
		"fail2ban-client status 'ss": jailStatus(7553, 247, "1.1.1.1"),
		"VELOCE_SIZE":                {Stdout: "VELOCE_SIZE 1000\n"},
	}}
	svc, st := newEvents(t, c)

	// Первый такт обязан МОЛЧАТЬ: иначе открытие панели вываливает в ленту всё
	// накопленное за сутки как происшествия прямо сейчас.
	got := append(svc.checkFail2ban(context.Background(), c, "srv1", st),
		svc.checkNginx(context.Background(), c, "srv1", st)...)
	if len(got) != 0 {
		t.Fatalf("первый такт выдал события: %+v", got)
	}
	if st.accessOffset != 1000 {
		t.Fatalf("позиция в логе не запомнена: %d", st.accessOffset)
	}
	if st.jails["sshd"].TotalFailed != 7553 {
		t.Fatalf("счётчики jail не запомнены: %+v", st.jails["sshd"])
	}
}

func TestNewBanBecomesEvent(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{
		"fail2ban-client status 2>":  {Stdout: "Status\n`- Jail list:\tsshd\n"},
		"fail2ban-client status 'ss": jailStatus(7553, 247, "1.1.1.1"),
	}}
	svc, st := newEvents(t, c)
	svc.checkFail2ban(context.Background(), c, "srv1", st)
	st.primed = true

	// Появился новый адрес в списке забаненных.
	c.replies["fail2ban-client status 'ss"] = jailStatus(7560, 248, "1.1.1.1 45.9.9.9")
	got := svc.checkFail2ban(context.Background(), c, "srv1", st)

	var ban *store.Incident
	for i := range got {
		if strings.Contains(got[i].Title, "45.9.9.9") {
			ban = &got[i]
		}
	}
	if ban == nil {
		t.Fatalf("бан не стал событием: %+v", got)
	}
	if ban.Severity != "warning" {
		t.Fatalf("важность %q", ban.Severity)
	}
	// Адрес обязан быть в заголовке: «забанен кто-то» не говорит ничего.
	if !strings.Contains(ban.Title, "45.9.9.9") {
		t.Fatalf("заголовок без адреса: %q", ban.Title)
	}
}

func TestFailedLoginsBelowThresholdStaySilent(t *testing.T) {
	c := &scriptedConn{replies: map[string]transport.Result{
		"fail2ban-client status 2>":  {Stdout: "Status\n`- Jail list:\tsshd\n"},
		"fail2ban-client status 'ss": jailStatus(100, 5, ""),
	}}
	svc, st := newEvents(t, c)
	svc.checkFail2ban(context.Background(), c, "srv1", st)
	st.primed = true

	// Отказы входа идут фоном круглосуточно. Событие на каждые два отказа
	// превращает ленту в шум, который перестают читать вместе с настоящими
	// тревогами.
	c.replies["fail2ban-client status 'ss"] = jailStatus(103, 5, "")
	if got := svc.checkFail2ban(context.Background(), c, "srv1", st); len(got) != 0 {
		t.Fatalf("три отказа стали событием: %+v", got)
	}

	c.replies["fail2ban-client status 'ss"] = jailStatus(103+failedLoginBurst, 5, "")
	got := svc.checkFail2ban(context.Background(), c, "srv1", st)
	if len(got) != 1 || got[0].Severity != "info" {
		t.Fatalf("всплеск отказов не замечен: %+v", got)
	}
}

func accessBurst(ip, path string, status, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, `%s - - [21/Aug/2026:14:38:00 +0000] "POST %s HTTP/1.1" %d 12`+"\n",
			ip, path, status)
	}
	return b.String()
}

func TestSingleAddressBurstBecomesWarning(t *testing.T) {
	body := accessBurst("45.9.9.9", "/api/login", 401, singleIPBurst)
	c := &scriptedConn{replies: map[string]transport.Result{
		"VELOCE_SIZE": {Stdout: "VELOCE_SIZE 5000\n" + body},
	}}
	svc, st := newEvents(t, c)
	st.primed = true
	st.accessOffset = 1000

	got := svc.checkNginx(context.Background(), c, "srv1", st)
	if len(got) != 1 {
		t.Fatalf("получено событий %d: %+v", len(got), got)
	}
	if got[0].Severity != "warning" || !strings.Contains(got[0].Title, "45.9.9.9") {
		t.Fatalf("событие не про подбор: %+v", got[0])
	}
	// Позиция обязана сдвинуться, иначе следующий такт разберёт те же строки
	// заново и выдаст то же событие второй раз.
	if st.accessOffset != 5000 {
		t.Fatalf("позиция %d", st.accessOffset)
	}
}

func TestServerErrorsAreCritical(t *testing.T) {
	body := accessBurst("1.1.1.1", "/api/x", 502, serverErrorBurst)
	c := &scriptedConn{replies: map[string]transport.Result{
		"VELOCE_SIZE": {Stdout: "VELOCE_SIZE 9000\n" + body},
	}}
	svc, st := newEvents(t, c)
	st.primed = true
	st.accessOffset = 1000

	got := svc.checkNginx(context.Background(), c, "srv1", st)
	if len(got) == 0 || got[0].Severity != "critical" {
		t.Fatalf("5xx не признаны критичными: %+v", got)
	}
}

func TestRotatedLogResetsPosition(t *testing.T) {
	// Ротация: файл стал меньше запомненной позиции. Читать с неё нельзя, а
	// разница «размер минус позиция» вышла бы отрицательной.
	c := &scriptedConn{replies: map[string]transport.Result{
		"VELOCE_SIZE": {Stdout: "VELOCE_SIZE 200\n"},
	}}
	svc, st := newEvents(t, c)
	st.primed = true
	st.accessOffset = 100000

	got := svc.checkNginx(context.Background(), c, "srv1", st)
	if len(got) != 0 {
		t.Fatalf("после ротации выдуманы события: %+v", got)
	}
	if st.accessOffset != 200 {
		t.Fatalf("позиция после ротации %d", st.accessOffset)
	}
}

func TestMissingSourcesAreSilent(t *testing.T) {
	// Ни fail2ban, ни nginx на сервере нет: источники просто выключены, а не
	// «ошибка», о которой надо кричать в ленте.
	c := &scriptedConn{replies: map[string]transport.Result{}}
	svc, st := newEvents(t, c)
	st.primed = true

	got := append(svc.checkFail2ban(context.Background(), c, "srv1", st),
		svc.checkNginx(context.Background(), c, "srv1", st)...)
	if len(got) != 0 {
		t.Fatalf("отсутствие источников дало события: %+v", got)
	}
}
