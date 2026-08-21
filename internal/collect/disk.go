package collect

import (
	"strconv"
	"strings"
)

type Disk struct {
	Source    string
	Mount     string
	SizeBytes uint64
	UsedBytes uint64
}

// Псевдофайловые системы, которые не надо показывать. Отбираем по префиксу
// источника: у настоящих разделов он начинается с /dev/, кроме перечисленных.
var pseudoFS = map[string]bool{
	"udev": true, "tmpfs": true, "devtmpfs": true, "overlay": true,
	"shm": true, "none": true,
}

// ParseDF не возвращает ошибку намеренно: нераспознанные строки просто
// пропускаются, а пустой список это законный ответ (у сервера может не быть ни
// одного обычного раздела в выводе). Сигнатура с error, который всегда nil,
// заставляла бы каждый вызов писать бессмысленную проверку.
func ParseDF(out string) []Disk {
	var res []Disk
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i, line := range lines {
		if i == 0 {
			continue // заголовок
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		if pseudoFS[f[0]] || !strings.HasPrefix(f[0], "/dev/") {
			continue
		}
		size, err1 := strconv.ParseUint(f[1], 10, 64)
		used, err2 := strconv.ParseUint(f[2], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		res = append(res, Disk{Source: f[0], SizeBytes: size, UsedBytes: used, Mount: f[3]})
	}
	return res
}
