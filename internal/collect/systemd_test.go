package collect

import "testing"

const unitsFixture = `  UNIT                LOAD   ACTIVE   SUB     DESCRIPTION
  bot.service         loaded active   running Discord bot
  nginx.service       loaded active   running A high performance web server
  postgresql.service  loaded active   exited  PostgreSQL RDBMS
  systemd-udevd.service loaded active running udev Kernel Device Manager

LOAD   = Reflects whether the unit definition was properly loaded.
4 loaded units listed.
`

func TestParseSystemctlUnits(t *testing.T) {
	got, err := ParseSystemctlUnits(unitsFixture)
	if err != nil {
		t.Fatalf("ParseSystemctlUnits: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("получено %d юнитов: %+v", len(got), got)
	}
	if got[0].Name != "bot.service" || got[0].Active != "active" || got[0].Sub != "running" {
		t.Fatalf("первый юнит %+v", got[0])
	}
	// Хвост с пояснениями и итогом не должен попасть в список.
	for _, u := range got {
		if u.Name == "LOAD" {
			t.Fatalf("в список попал текст легенды")
		}
	}
}

func TestParseShowProperties(t *testing.T) {
	got, err := ParseShowProperties("FragmentPath=/etc/systemd/system/bot.service\nNRestarts=3\n")
	if err != nil {
		t.Fatalf("ParseShowProperties: %v", err)
	}
	if got["FragmentPath"] != "/etc/systemd/system/bot.service" {
		t.Fatalf("получено %+v", got)
	}
}

func TestIsUserUnit(t *testing.T) {
	// Юниты из пакетов скрываются: иначе первый экран это полсотни системных
	// служб и один нужный где-то посередине.
	if !IsUserUnit("/etc/systemd/system/bot.service") {
		t.Fatal("юнит из /etc должен считаться пользовательским")
	}
	if IsUserUnit("/lib/systemd/system/nginx.service") {
		t.Fatal("юнит из /lib пользовательским не является")
	}
	if IsUserUnit("/usr/lib/systemd/system/ssh.service") {
		t.Fatal("юнит из /usr/lib пользовательским не является")
	}
}
