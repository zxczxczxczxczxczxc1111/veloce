package collect

import "testing"

const jailStatusFixture = `Status for the jail: sshd
|- Filter
|  |- Currently failed:	1
|  |- Total failed:	7553
|  ` + "`" + `- Journal matches:	_SYSTEMD_UNIT=sshd.service + _COMM=sshd
` + "`" + `- Actions
   |- Currently banned:	2
   |- Total banned:	247
   ` + "`" + `- Banned IP list:	45.135.232.17 193.32.162.99
`

func TestParseJailList(t *testing.T) {
	out := `Status
|- Number of jail:	2
` + "`" + `- Jail list:	sshd, nginx-limit
`
	got := ParseJailList(out)
	if len(got) != 2 || got[0] != "sshd" || got[1] != "nginx-limit" {
		t.Fatalf("разобрано %v", got)
	}
}

func TestParseJailStatus(t *testing.T) {
	got := ParseJailStatus(jailStatusFixture)
	if got.TotalFailed != 7553 {
		t.Fatalf("всего отказов %d", got.TotalFailed)
	}
	if got.TotalBanned != 247 {
		t.Fatalf("всего банов %d", got.TotalBanned)
	}
	if got.CurrentlyBanned != 2 {
		t.Fatalf("сейчас забанено %d", got.CurrentlyBanned)
	}
	// Список адресов нужен целиком: событие «забанен 45.135.232.17» полезно, а
	// «забанен кто-то» бесполезно.
	if len(got.BannedIPs) != 2 || got.BannedIPs[0] != "45.135.232.17" {
		t.Fatalf("адреса %v", got.BannedIPs)
	}
}

func TestParseJailStatusWithEmptyBanList(t *testing.T) {
	out := "Status for the jail: sshd\n   `- Banned IP list:\t\n"
	got := ParseJailStatus(out)
	if len(got.BannedIPs) != 0 {
		t.Fatalf("из пустого списка взялись адреса: %v", got.BannedIPs)
	}
}

func TestParseAccessLine(t *testing.T) {
	line := `45.135.232.17 - - [21/Aug/2026:14:38:00 +0000] "POST /api/login HTTP/1.1" 401 123 "-" "curl/8.5"`
	got, ok := ParseAccessLine(line)
	if !ok {
		t.Fatal("строка не разобрана")
	}
	if got.IP != "45.135.232.17" || got.Method != "POST" || got.Path != "/api/login" || got.Status != 401 {
		t.Fatalf("разобрано %+v", got)
	}
}

func TestParseAccessLineSurvivesGarbage(t *testing.T) {
	// В access.log попадает всякое: обрезанные строки, чужой формат, мусор от
	// сканеров. Одна такая строка не должна ронять разбор всего такта.
	for _, bad := range []string{"", "мусор", `1.2.3.4 - - [21/Aug/2026] "GET"`} {
		if _, ok := ParseAccessLine(bad); ok {
			t.Fatalf("мусор разобран как запись: %q", bad)
		}
	}
}

func TestSummarizeAccessCountsErrorsAndTops(t *testing.T) {
	lines := []string{
		`1.1.1.1 - - [x] "GET /ok HTTP/1.1" 200 1`,
		`45.1.1.1 - - [x] "POST /api/login HTTP/1.1" 401 1`,
		`45.1.1.1 - - [x] "POST /api/login HTTP/1.1" 401 1`,
		`45.1.1.1 - - [x] "POST /api/login HTTP/1.1" 403 1`,
		`9.9.9.9 - - [x] "GET /boom HTTP/1.1" 502 1`,
		"мусор, который надо пропустить",
	}
	got := SummarizeAccess(lines)
	if got.Total != 5 {
		t.Fatalf("разобрано строк %d", got.Total)
	}
	if got.ClientErrors != 3 {
		t.Fatalf("4xx: %d", got.ClientErrors)
	}
	if got.ServerErrors != 1 {
		t.Fatalf("5xx: %d", got.ServerErrors)
	}
	// Топ считается ТОЛЬКО по ошибкам: самый частый адрес вообще это обычный
	// посетитель, и показывать его как источник тревоги неверно.
	if got.TopIP != "45.1.1.1" || got.TopIPCount != 3 {
		t.Fatalf("топ адрес %q (%d)", got.TopIP, got.TopIPCount)
	}
	if got.TopPath != "/api/login" || got.TopPathCount != 3 {
		t.Fatalf("топ путь %q (%d)", got.TopPath, got.TopPathCount)
	}
}
