package service

import "testing"

func TestRingBufferDropsOldest(t *testing.T) {
	rb := newRing(3)
	rb.push("a")
	rb.push("b")
	rb.push("c")
	rb.push("d")

	got := rb.lines()
	if len(got) != 3 {
		t.Fatalf("в буфере %d строк, ожидалось 3", len(got))
	}
	// Держать десятки тысяч строк в памяти нельзя, старое выбрасывается.
	if got[0] != "b" || got[2] != "d" {
		t.Fatalf("получено %+v", got)
	}
}

func TestShellQuoteEscapesQuotes(t *testing.T) {
	// Имя проекта приезжает с сервера, доверенным не является.
	got := shellQuote(`a'; rm -rf /; echo '`)
	if got[0] != '\'' || got[len(got)-1] != '\'' {
		t.Fatalf("аргумент не обёрнут в кавычки: %s", got)
	}
	// Внутренняя кавычка обязана быть разбита, иначе строка закрывается раньше
	// времени и хвост уезжает оболочке как команда.
	if got == `'a'; rm -rf /; echo ''` {
		t.Fatalf("кавычка не экранирована: %s", got)
	}
}

func TestLogKeySeparatesServers(t *testing.T) {
	// Один и тот же проект на двух серверах не должен делить стрим и кольцо.
	if logKey("a", "nginx") == logKey("b", "nginx") {
		t.Fatal("ключи логов на разных серверах совпали")
	}
}
