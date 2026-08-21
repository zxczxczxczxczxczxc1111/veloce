package collect

import "strings"

type Unit struct {
	Name         string
	Active       string
	Sub          string
	FragmentPath string
}

// ParseSystemctlUnits разбирает вывод
// `systemctl list-units --type=service --all --no-pager --no-legend --plain`.
// Флаги --no-legend и --plain убирают шапку, легенду и точки состояния, но код
// не полагается на них: вывод могли получить и без флагов, поэтому лишние
// строки отсекаются по форме.
func ParseSystemctlUnits(out string) ([]Unit, error) {
	var res []Unit
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		// systemd помечает проблемные юниты символом в начале строки.
		line = strings.TrimLeft(line, "*•●× ")
		if line == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		if !strings.HasSuffix(f[0], ".service") {
			continue // шапка, легенда, итоговая строка
		}
		res = append(res, Unit{Name: f[0], Active: f[2], Sub: f[3]})
	}
	return res, nil
}

// ParseShowProperties разбирает вывод `systemctl show <unit> --property=A --property=B`
// в виде KEY=VALUE построчно.
func ParseShowProperties(out string) (map[string]string, error) {
	res := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		res[line[:i]] = line[i+1:]
	}
	return res, nil
}

// IsUserUnit отличает поставленное руками от пришедшего из пакетов.
func IsUserUnit(fragmentPath string) bool {
	if fragmentPath == "" {
		return false
	}
	return strings.HasPrefix(fragmentPath, "/etc/systemd/")
}
