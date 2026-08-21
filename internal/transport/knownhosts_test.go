package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// sampleKey отдаёт публичный ключ, которым можно наполнить known_hosts.
// Ed25519, а не RSA: тестам нужен просто валидный ключ, а генерация RSA на
// каждый случай стоит заметного времени.
func sampleKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("генерация ключа: %v", err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("публичный ключ: %v", err)
	}
	return key
}

func TestLookupKnownHostFindsPlainEntry(t *testing.T) {
	key := sampleKey(t)
	raw := knownhosts.Line([]string{"example.com"}, key) + "\n"

	got := lookupKnownHost([]byte(raw), "example.com:22")
	if want := ssh.FingerprintSHA256(key); got != want {
		t.Fatalf("отпечаток %q, ожидался %q", got, want)
	}
}

func TestLookupKnownHostFindsEntryWithPort(t *testing.T) {
	key := sampleKey(t)
	raw := knownhosts.Line([]string{"[example.com]:2222"}, key) + "\n"

	if got := lookupKnownHost([]byte(raw), "example.com:2222"); got == "" {
		t.Fatal("запись с нестандартным портом не найдена")
	}
	// Порт различает записи: тот же хост на 22 подтверждённым не считается.
	if got := lookupKnownHost([]byte(raw), "example.com:22"); got != "" {
		t.Fatalf("запись с порта 2222 подошла порту 22: %q", got)
	}
}

func TestLookupKnownHostFindsHashedEntry(t *testing.T) {
	key := sampleKey(t)
	// OpenSSH с HashKnownHosts=yes пишет именно так. Не понимать этот формат
	// значит показывать «хост не подтверждён» тем, у кого он подтверждён.
	raw := knownhosts.Line([]string{knownhosts.HashHostname("example.com")}, key) + "\n"

	if got := lookupKnownHost([]byte(raw), "example.com:22"); got != ssh.FingerprintSHA256(key) {
		t.Fatalf("хешированная запись не найдена: %q", got)
	}
}

func TestLookupKnownHostSkipsBadLinesAndComments(t *testing.T) {
	key := sampleKey(t)
	raw := "# комментарий\n" +
		"мусор без ключа\n" +
		"\n" +
		knownhosts.Line([]string{"example.com"}, key) + "\n"

	// Одна битая строка не должна прятать все остальные: у людей в файле
	// лежит всякое, а known_hosts правится руками годами.
	if got := lookupKnownHost([]byte(raw), "example.com:22"); got == "" {
		t.Fatal("битая строка выше заслонила настоящую запись")
	}
}

func TestLookupKnownHostIgnoresRevoked(t *testing.T) {
	key := sampleKey(t)
	raw := "@revoked " + knownhosts.Line([]string{"example.com"}, key) + "\n"

	if got := lookupKnownHost([]byte(raw), "example.com:22"); got != "" {
		t.Fatalf("отозванный ключ показан как подтверждённый: %q", got)
	}
}

func TestFilterKnownHostRemovesOnlyMatchingLine(t *testing.T) {
	key := sampleKey(t)
	raw := knownhosts.Line([]string{"other.com"}, key) + "\n" +
		knownhosts.Line([]string{"example.com"}, key) + "\n"

	out := string(filterKnownHost([]byte(raw), "example.com:22"))
	if strings.Contains(out, "example.com") {
		t.Fatalf("запись не убрана: %q", out)
	}
	if !strings.Contains(out, "other.com") {
		t.Fatalf("соседняя запись пропала: %q", out)
	}
}

func TestKnownHostFingerprintAndRemoveWorkOnDisk(t *testing.T) {
	key := sampleKey(t)
	home := t.TempDir()
	// UserHomeDir на Windows читает USERPROFILE, на остальных HOME.
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".ssh", "known_hosts")
	line := knownhosts.Line([]string{"example.com"}, key) + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := KnownHostFingerprint("example.com:22")
	if err != nil {
		t.Fatal(err)
	}
	if got != ssh.FingerprintSHA256(key) {
		t.Fatalf("отпечаток %q", got)
	}

	if err := RemoveKnownHost("example.com:22"); err != nil {
		t.Fatal(err)
	}
	got, err = KnownHostFingerprint("example.com:22")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("после забывания ключа отпечаток всё ещё есть: %q", got)
	}
}

func TestKnownHostFingerprintOnMissingFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	// Отсутствующий файл это не ошибка, а «хост не подтверждён».
	got, err := KnownHostFingerprint("example.com:22")
	if err != nil {
		t.Fatalf("отсутствие файла считается ошибкой: %v", err)
	}
	if got != "" {
		t.Fatalf("отпечаток из ниоткуда: %q", got)
	}
	if err := RemoveKnownHost("example.com:22"); err != nil {
		t.Fatalf("забывание несуществующего ключа считается ошибкой: %v", err)
	}
}

func TestChangedHostKeyIsReportedSeparately(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}

	old := sampleKey(t)
	fresh := sampleKey(t)
	line := knownhosts.Line([]string{"example.com"}, old) + "\n"
	if err := os.WriteFile(filepath.Join(home, ".ssh", "known_hosts"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	policy, err := KnownHosts()
	if err != nil {
		t.Fatal(err)
	}

	// Смена ключа у известного хоста это либо законная пересборка сервера,
	// либо подмена. Свалить её в «неизвестный хост» значит предложить
	// человеку кнопку «доверять» там, где надо остановиться и подумать.
	err = policy("example.com:22", fresh)
	var changed *ErrHostKeyChanged
	if !errors.As(err, &changed) {
		t.Fatalf("ожидалась ErrHostKeyChanged, получено %v", err)
	}
	if changed.Fingerprint != ssh.FingerprintSHA256(fresh) {
		t.Fatalf("новый отпечаток %q", changed.Fingerprint)
	}
	if changed.Known != ssh.FingerprintSHA256(old) {
		t.Fatalf("сохранённый отпечаток %q, ожидался %q",
			changed.Known, ssh.FingerprintSHA256(old))
	}

	// Тот же ключ, что записан, проходит молча.
	if err := policy("example.com:22", old); err != nil {
		t.Fatalf("совпадающий ключ отвергнут: %v", err)
	}
}
