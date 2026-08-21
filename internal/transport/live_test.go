package transport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Проверка против НАСТОЯЩЕГО сервера. Запускается только при заданном
// VELOCE_LIVE_HOST, в обычном прогоне молчит, поэтому CI от неё не зависит.
//
//	$env:VELOCE_LIVE_HOST="..."; $env:VELOCE_LIVE_USER="root"
//	$env:VELOCE_LIVE_KEY="$env:USERPROFILE\.ssh\ключ"
//	go test ./internal/transport/ -run TestLive -v
//
// Все команды здесь read-only, на сервере не меняется ничего. Настоящий
// known_hosts тоже не трогается: HOME уводится во временный каталог.

func liveCfg(t *testing.T) Config {
	t.Helper()
	host := os.Getenv("VELOCE_LIVE_HOST")
	if host == "" {
		t.Skip("VELOCE_LIVE_HOST не задан")
	}
	return Config{
		Host:    host,
		Port:    22,
		User:    os.Getenv("VELOCE_LIVE_USER"),
		KeyPath: os.Getenv("VELOCE_LIVE_KEY"),
	}
}

// tempKnownHosts уводит HOME во временный каталог: настоящий known_hosts
// пользователя трогать нельзя, а проверить надо и «неизвестный хост», и
// «ключ сменился», и запись согласия.
func tempKnownHosts(t *testing.T, content string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	if content != "" {
		err := os.WriteFile(filepath.Join(home, ".ssh", "known_hosts"), []byte(content), 0o600)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestLiveUnknownThenTrustedHostKey(t *testing.T) {
	cfg := liveCfg(t)
	tempKnownHosts(t, "")

	policy, err := KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Dial(context.Background(), cfg, policy)
	var unknown *ErrHostKeyUnknown
	if !errors.As(err, &unknown) {
		t.Fatalf("ожидался неизвестный ключ хоста, получено: %v", err)
	}
	t.Logf("неизвестный хост, отпечаток: %s", unknown.Fingerprint)
	if StateForError(err) != StateHostKeyUnknown {
		t.Fatal("состояние разобрано неверно")
	}

	// Повторяем то, что делает TrustHost: соединяемся, сверяя показанный
	// отпечаток, и только потом пишем в known_hosts.
	var seen ssh.PublicKey
	grab := func(_ string, key ssh.PublicKey) error {
		if got := ssh.FingerprintSHA256(key); got != unknown.Fingerprint {
			t.Fatalf("ключ сменился между показом и подтверждением: %s", got)
		}
		seen = key
		return nil
	}
	conn, err := Dial(context.Background(), cfg, grab)
	if err != nil {
		t.Fatalf("подключение с согласия пользователя: %v", err)
	}
	conn.Close()

	hostport := HostPort(cfg.Host, cfg.Port)
	if err := AppendKnownHost(hostport, seen); err != nil {
		t.Fatal(err)
	}

	got, err := KnownHostFingerprints(hostport)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Fingerprint != unknown.Fingerprint {
		t.Fatalf("после записи отпечатки %v, показывали %q", got, unknown.Fingerprint)
	}

	// Теперь хост известен: политика обязана пропустить его молча.
	policy, err = KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	live, err := Dial(context.Background(), cfg, policy)
	if err != nil {
		t.Fatalf("подключение к подтверждённому хосту: %v", err)
	}
	defer live.Close()

	// Живая read-only команда: связь настоящая, а не «рукопожатие прошло».
	res, err := live.Run(context.Background(), "uptime -p; id -un")
	if err != nil {
		t.Fatalf("команда: %v", err)
	}
	t.Logf("сервер ответил: %s", strings.TrimSpace(res.Stdout))

	// И забывание ключа на живом отпечатке.
	if err := RemoveKnownHost(hostport); err != nil {
		t.Fatal(err)
	}
	got, err = KnownHostFingerprints(hostport)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("ключ не забыт: %v", got)
	}
}

func TestLiveChangedHostKey(t *testing.T) {
	cfg := liveCfg(t)

	// Кладём в known_hosts ЧУЖОЙ ключ для этого адреса: ровно то, что увидит
	// человек при пересборке сервера или при подмене.
	other := sampleKey(t)
	tempKnownHosts(t, knownhosts.Line([]string{HostPort(cfg.Host, cfg.Port)}, other)+"\n")

	policy, err := KnownHosts()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Dial(context.Background(), cfg, policy)
	var changed *ErrHostKeyChanged
	if !errors.As(err, &changed) {
		t.Fatalf("ожидалась смена ключа хоста, получено: %v", err)
	}
	if changed.Known != ssh.FingerprintSHA256(other) {
		t.Fatalf("сохранённый отпечаток %q", changed.Known)
	}
	if changed.Fingerprint == changed.Known {
		t.Fatal("оба отпечатка совпали, сравнивать человеку нечего")
	}
	t.Logf("сохранён %s, пришёл %s", changed.Known, changed.Fingerprint)
	if StateForError(err) != StateHostKeyChanged {
		t.Fatal("состояние разобрано неверно")
	}
}

func TestLiveWrongUser(t *testing.T) {
	cfg := liveCfg(t)
	// Ровно ОДНА попытка: на сервере fail2ban, и долбиться неверным логином
	// значит забанить себе же рабочую машину.
	cfg.User = "veloce-no-such-user"
	tempKnownHosts(t, "")

	accept := func(string, ssh.PublicKey) error { return nil }
	_, err := Dial(context.Background(), cfg, accept)
	if err == nil {
		t.Fatal("сервер пустил несуществующего пользователя")
	}
	if got := StateForError(err); got != StateAuthFailed {
		t.Fatalf("состояние %v, ожидалось StateAuthFailed: %v", got, err)
	}
	t.Logf("отказ аутентификации разобран верно: %v", err)
}

func TestLiveMissingHost(t *testing.T) {
	cfg := liveCfg(t)
	cfg.Host = "veloce-such-host-does-not-exist.invalid"
	tempKnownHosts(t, "")

	accept := func(string, ssh.PublicKey) error { return nil }
	_, err := Dial(context.Background(), cfg, accept)
	if err == nil {
		t.Fatal("несуществующий хост ответил")
	}
	// Именно «связи нет», а не «ключ не принят»: чинить надо разное.
	if got := StateForError(err); got != StateDisconnected {
		t.Fatalf("состояние %v: %v", got, err)
	}
	t.Logf("несуществующий хост разобран верно: %v", err)
}
