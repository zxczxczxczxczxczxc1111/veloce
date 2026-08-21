package store

import (
	"path/filepath"
	"testing"
)

func openStore(t *testing.T) (*IncidentStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "events.json")
	es, err := OpenIncidents(path)
	if err != nil {
		t.Fatal(err)
	}
	return es, path
}

func TestEventsSurviveRestart(t *testing.T) {
	es, path := openStore(t)
	es.Append(Incident{ServerID: "a", At: 1, Source: "fail2ban", Severity: "warning", Title: "бан"})

	// Вопрос «что было ночью» это единственная причина, по которой события
	// вообще хранятся. Не пережив перезапуск, лента бесполезна.
	again, err := OpenIncidents(path)
	if err != nil {
		t.Fatal(err)
	}
	got := again.List("a")
	if len(got) != 1 || got[0].Title != "бан" {
		t.Fatalf("после перезапуска: %+v", got)
	}
}

func TestEventsKeepNewestPerServer(t *testing.T) {
	es, _ := openStore(t)
	for i := 0; i < IncidentsPerServer+10; i++ {
		es.Append(Incident{ServerID: "a", At: int64(i), Title: "шум"})
	}
	es.Append(Incident{ServerID: "b", At: 1, Title: "другой сервер"})

	got := es.List("a")
	if len(got) != IncidentsPerServer {
		t.Fatalf("хранится %d событий", len(got))
	}
	// Выбрасываем СТАРЫЕ: свежие важнее, а лента без предела съест диск.
	if got[0].At != 10 {
		t.Fatalf("первое событие %d, ожидалось 10", got[0].At)
	}
	if len(es.List("b")) != 1 {
		t.Fatal("кольцо одного сервера задело другой")
	}
}

func TestUnreadCountAndMarkRead(t *testing.T) {
	es, _ := openStore(t)
	es.Append(Incident{ServerID: "a", At: 1, Title: "раз"})
	es.Append(Incident{ServerID: "a", At: 2, Title: "два"})
	es.Append(Incident{ServerID: "b", At: 3, Title: "чужое"})

	if n := es.Unread("a"); n != 2 {
		t.Fatalf("непрочитанных %d", n)
	}
	if err := es.MarkRead("a"); err != nil {
		t.Fatal(err)
	}
	if n := es.Unread("a"); n != 0 {
		t.Fatalf("после отметки осталось %d", n)
	}
	// Отметка на одном сервере не должна гасить счётчик другого.
	if n := es.Unread("b"); n != 1 {
		t.Fatalf("у соседа %d", n)
	}
}

func TestListReturnsCopy(t *testing.T) {
	es, _ := openStore(t)
	es.Append(Incident{ServerID: "a", At: 1, Title: "исходное"})
	got := es.List("a")
	got[0].Title = "подменено"
	if es.List("a")[0].Title != "исходное" {
		t.Fatal("список отдал ссылку на внутренние данные")
	}
}
