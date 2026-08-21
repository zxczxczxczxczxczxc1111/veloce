package service

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/store"
	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// tempHomeWithKnownHost кладёт хост в known_hosts во временном профиле.
func tempHomeWithKnownHost(t *testing.T, entry string) ssh.PublicKey {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	if entry != "" {
		line := knownhosts.Line([]string{entry}, key) + "\n"
		err = os.WriteFile(filepath.Join(home, ".ssh", "known_hosts"), []byte(line), 0o600)
		if err != nil {
			t.Fatal(err)
		}
	}
	return key
}

func storeWith(t *testing.T, servers ...store.Server) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "servers.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range servers {
		if err := st.Put(s); err != nil {
			t.Fatal(err)
		}
	}
	return st
}

func TestFingerprintReadsKnownHosts(t *testing.T) {
	key := tempHomeWithKnownHost(t, "example.com")
	st := storeWith(t, store.Server{ID: "a", Host: "example.com", Port: 22, User: "root"})
	svc := NewServersService(nil, st, NewConnRegistry())

	got, err := svc.Fingerprint("a")
	if err != nil {
		t.Fatal(err)
	}
	if got != ssh.FingerprintSHA256(key) {
		t.Fatalf("отпечаток %q", got)
	}
}

func TestFingerprintUsesDefaultPortWhenZero(t *testing.T) {
	// Порт 0 в хранилище значит 22. Считай мы адрес как "example.com:0",
	// отпечаток подтверждённого хоста молча пропал бы с экрана.
	tempHomeWithKnownHost(t, "example.com")
	st := storeWith(t, store.Server{ID: "a", Host: "example.com", User: "root"})
	svc := NewServersService(nil, st, NewConnRegistry())

	got, err := svc.Fingerprint("a")
	if err != nil {
		t.Fatal(err)
	}
	if got == "" {
		t.Fatal("порт 0 не сведён к 22")
	}
}

func TestFingerprintEmptyForUnconfirmedHost(t *testing.T) {
	tempHomeWithKnownHost(t, "")
	st := storeWith(t, store.Server{ID: "a", Host: "example.com", User: "root"})
	svc := NewServersService(nil, st, NewConnRegistry())

	got, err := svc.Fingerprint("a")
	if err != nil {
		t.Fatalf("неподтверждённый хост считается ошибкой: %v", err)
	}
	if got != "" {
		t.Fatalf("отпечаток из ниоткуда: %q", got)
	}
}

func TestFingerprintUnknownServer(t *testing.T) {
	tempHomeWithKnownHost(t, "")
	svc := NewServersService(nil, storeWith(t), NewConnRegistry())

	if _, err := svc.Fingerprint("нет-такого"); err == nil {
		t.Fatal("отсутствующий сервер обязан быть ошибкой, а не пустой строкой")
	}
}

func TestForgetHostRemovesEntry(t *testing.T) {
	tempHomeWithKnownHost(t, "example.com")
	st := storeWith(t, store.Server{ID: "a", Host: "example.com", User: "root"})
	svc := NewServersService(nil, st, NewConnRegistry())

	if err := svc.ForgetHost("a"); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Fingerprint("a")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("ключ не забыт: %q", got)
	}
}

func TestStateForConnectErrorSeparatesCauses(t *testing.T) {
	// Connect обязан раскладывать отказ по видам сам: на первом подключении
	// хука состояния ещё нет, и без этого разбора интерфейс получил бы одно
	// общее «не удалось», против которого прямо возражает спека раздела 10.
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"бастион", fmt.Errorf("обёртка: %w", transport.ErrJumpFailed), "jumpFailed"},
		{"ключ не принят", errors.New("ssh: handshake failed: unable to authenticate"), "authFailed"},
		{"сеть", errors.New("dial tcp: connection refused"), "disconnected"},
	}
	for _, c := range cases {
		if got := stateName(transport.StateForError(c.err)); got != c.want {
			t.Fatalf("%s: состояние %q, ожидалось %q", c.name, got, c.want)
		}
	}
}
