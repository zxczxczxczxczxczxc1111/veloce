package collect

import (
	"regexp"
	"strconv"
	"strings"
)

// JailStatus - разбор вывода `fail2ban-client status <jail>`.
//
// Счётчики берём как есть, а решение «событие или нет» принимает слой выше:
// «всего отказов 7553» это не тревога, а факт за всё время жизни сервера.
// Тревога это ПРИРОСТ между двумя тактами.
type JailStatus struct {
	Name            string
	CurrentlyFailed int
	TotalFailed     int
	CurrentlyBanned int
	TotalBanned     int
	BannedIPs       []string
}

// ParseJailList разбирает `fail2ban-client status`: список jail в одной строке
// через запятую.
func ParseJailList(out string) []string {
	for _, line := range strings.Split(out, "\n") {
		i := strings.Index(line, "Jail list:")
		if i < 0 {
			continue
		}
		var res []string
		for _, name := range strings.Split(line[i+len("Jail list:"):], ",") {
			name = strings.TrimSpace(name)
			if name != "" {
				res = append(res, name)
			}
		}
		return res
	}
	return nil
}

// ParseJailStatus разбирает вывод по одному jail. Формат псевдографический
// (`|-`, "`-"), поэтому опираемся на подписи полей, а не на позиции: рамка
// меняется между версиями fail2ban, подписи стабильны.
func ParseJailStatus(out string) JailStatus {
	var st JailStatus
	for _, line := range strings.Split(out, "\n") {
		key, val, ok := splitLabeled(line)
		if !ok {
			continue
		}
		switch key {
		case "Status for the jail":
			st.Name = val
		case "Currently failed":
			st.CurrentlyFailed = atoi(val)
		case "Total failed":
			st.TotalFailed = atoi(val)
		case "Currently banned":
			st.CurrentlyBanned = atoi(val)
		case "Total banned":
			st.TotalBanned = atoi(val)
		case "Banned IP list":
			st.BannedIPs = strings.Fields(val)
		}
	}
	return st
}

// splitLabeled достаёт «подпись: значение», отбрасывая псевдографику слева.
func splitLabeled(line string) (string, string, bool) {
	trimmed := strings.TrimLeft(line, " \t|`-")
	i := strings.Index(trimmed, ":")
	if i <= 0 {
		return "", "", false
	}
	return strings.TrimSpace(trimmed[:i]), strings.TrimSpace(trimmed[i+1:]), true
}

func atoi(s string) int {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return v
}

// AccessEntry - одна разобранная строка access.log nginx.
type AccessEntry struct {
	IP     string
	Method string
	Path   string
	Status int
}

// Общий формат nginx: адрес, два поля идентификации, время в скобках, запрос в
// кавычках, код, размер. Разбираем выражением, а не разбиением по пробелам:
// в запросе и в user-agent пробелы есть всегда, и поле «девятое по счёту»
// разъезжается на первой же строке с непустым рефером.
var accessRe = regexp.MustCompile(`^(\S+) \S+ \S+ \[[^\]]*\] "(\S+) (\S+)[^"]*" (\d{3})`)

func ParseAccessLine(line string) (AccessEntry, bool) {
	m := accessRe.FindStringSubmatch(line)
	if m == nil {
		return AccessEntry{}, false
	}
	return AccessEntry{IP: m[1], Method: m[2], Path: m[3], Status: atoi(m[4])}, true
}

// TrafficSummary - итог по пачке новых строк access.log.
type TrafficSummary struct {
	Total        int
	ClientErrors int // 4xx
	ServerErrors int // 5xx
	// Топ считается ТОЛЬКО по ошибкам. Самый частый адрес вообще это обычный
	// посетитель, и показывать его как источник тревоги значит указать пальцем
	// не туда.
	TopIP        string
	TopIPCount   int
	TopPath      string
	TopPathCount int
}

func SummarizeAccess(lines []string) TrafficSummary {
	var s TrafficSummary
	byIP := map[string]int{}
	byPath := map[string]int{}

	for _, line := range lines {
		e, ok := ParseAccessLine(line)
		if !ok {
			// Мусор в логе это норма: обрезанные строки, чужой формат, следы
			// сканеров. Пропускаем молча, весь такт из-за одной строки не
			// теряем.
			continue
		}
		s.Total++
		switch {
		case e.Status >= 500:
			s.ServerErrors++
		case e.Status >= 400:
			s.ClientErrors++
		default:
			continue
		}
		byIP[e.IP]++
		byPath[e.Path]++
	}

	s.TopIP, s.TopIPCount = top(byIP)
	s.TopPath, s.TopPathCount = top(byPath)
	return s
}

func top(m map[string]int) (string, int) {
	bestKey, bestVal := "", 0
	for k, v := range m {
		// При равенстве берём меньший ключ: иначе один и тот же такт давал бы
		// разный ответ от запуска к запуску, а событие «источник сменился»
		// появлялось бы на ровном месте.
		if v > bestVal || (v == bestVal && bestKey != "" && k < bestKey) {
			bestKey, bestVal = k, v
		}
	}
	return bestKey, bestVal
}
