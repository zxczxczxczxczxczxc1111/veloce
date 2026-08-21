package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPutAndListRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "servers.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	srv := Server{ID: "s1", Label: "Прод", Host: "1.2.3.4", Port: 22, User: "root",
		Tags: []string{"прод"}}
	if err := s.Put(srv); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Перечитываем с диска, а не из памяти: проверяем именно сохранение.
	s2, err := Open(filepath.Join(dir, "servers.json"))
	if err != nil {
		t.Fatalf("повторный Open: %v", err)
	}
	got := s2.List()
	if len(got) != 1 || got[0].Label != "Прод" {
		t.Fatalf("получено %+v", got)
	}
}

func TestNeverStoresSecrets(t *testing.T) {
	// Защита от будущего себя: если кто-то добавит в Server поле под пароль
	// или парольную фразу, этот тест должен упасть.
	dir := t.TempDir()
	s, _ := Open(filepath.Join(dir, "servers.json"))
	s.Put(Server{ID: "s1", Host: "h", KeyPath: `C:\keys\id_ed25519`})

	raw := readFile(t, filepath.Join(dir, "servers.json"))
	for _, bad := range []string{"password", "passphrase", "secret", "PRIVATE KEY"} {
		if containsFold(raw, bad) {
			t.Fatalf("в конфиг попало %q", bad)
		}
	}
}

func TestDeleteServerRemovesItsOverrides(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(filepath.Join(dir, "servers.json"))
	s.Put(Server{ID: "s1", Host: "h1"})
	s.PutOverride(ProjectOverride{ServerID: "s1", Kind: "docker", ID: "web", Hidden: true})

	if err := s.Delete("s1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := s.Overrides("s1"); len(got) != 0 {
		t.Fatalf("настройки удалённого сервера остались: %+v", got)
	}
}

func TestOverrideKeySeparatesKinds(t *testing.T) {
	// Контейнер nginx и юнит nginx.service это разные проекты, и путать их
	// настройки нельзя.
	a := ProjectOverride{Kind: "docker", ID: "nginx"}
	b := ProjectOverride{Kind: "systemd", ID: "nginx"}
	if a.Key() == b.Key() {
		t.Fatal("ключи разных типов совпали")
	}
}

// TestDeleteKeepsOtherServers ловит классическую ловушку среза: Delete
// переиспользует нижележащий массив через s.servers[:0], и ошибка в этом месте
// незаметна, пока сервер в списке ровно один.
func TestDeleteKeepsOtherServers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "servers.json")
	s, _ := Open(path)
	s.Put(Server{ID: "s1", Host: "h1"})
	s.Put(Server{ID: "s2", Host: "h2"})
	s.Put(Server{ID: "s3", Host: "h3"})
	s.PutOverride(ProjectOverride{ServerID: "s2", Kind: "docker", ID: "web"})
	s.PutOverride(ProjectOverride{ServerID: "s3", Kind: "docker", ID: "api"})

	if err := s.Delete("s2"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("повторный Open: %v", err)
	}
	got := reopened.List()
	if len(got) != 2 || got[0].ID != "s1" || got[1].ID != "s3" {
		t.Fatalf("после удаления осталось %+v", got)
	}
	if len(reopened.Overrides("s3")) != 1 {
		t.Fatal("настройки уцелевшего сервера потерялись")
	}
	if len(reopened.Overrides("s2")) != 0 {
		t.Fatal("настройки удалённого сервера остались на диске")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("чтение конфига: %v", err)
	}
	return string(b)
}

func containsFold(hay, needle string) bool {
	return strings.Contains(strings.ToLower(hay), strings.ToLower(needle))
}
