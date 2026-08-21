package collect

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// Разделитель между кусками вывода. Выбран так, чтобы гарантированно не
// встретиться в выводе перечисленных команд.
const sep = "###VELOCE###"

const hostCmd = `cat /proc/stat; echo '` + sep + `'; ` +
	`cat /proc/meminfo; echo '` + sep + `'; ` +
	`df -B1 --output=source,size,used,target; echo '` + sep + `'; ` +
	`cat /proc/net/dev; echo '` + sep + `'; ` +
	`cat /proc/uptime`

var errShortOutput = errors.New("вывод короче ожидаемого, команда выполнилась не полностью")

type HostSnapshot struct {
	CPUPercent float64
	Mem        Memory
	Disks      []Disk
	RxPerSec   float64
	TxPerSec   float64
	Uptime     time.Duration
	// Valid=false у первого снимка: дельту не с чем считать, и показывать
	// значение с момента загрузки сервера значит рисовать прямую линию вместо
	// нагрузки.
	Valid bool
	// Missing перечисляет куски, которые не удалось прочитать или разобрать.
	// Интерфейс показывает по ним прочерк, а не ноль: ноль это значение, а
	// прочерк это отсутствие значения, и путать их нельзя.
	Missing []string
}

type HostCollector struct {
	prevCPU CPUSample
	prevNet NetSample
	prevAt  time.Time
	hasPrev bool
}

func NewHostCollector() *HostCollector { return &HostCollector{} }

func (h *HostCollector) Collect(ctx context.Context, c transport.Conn) (HostSnapshot, error) {
	res, err := c.Run(ctx, hostCmd)
	if err != nil {
		return HostSnapshot{}, err
	}
	parts := strings.Split(res.Stdout, sep)
	// Каждый кусок разбирается отдельно и падает отдельно. Раньше один
	// нечитаемый файл ронял весь снимок целиком: на сервере без /proc/net/dev
	// пользователь не увидел бы ни процессора, ни памяти, ни диска, хотя
	// четыре куска из пяти пришли нормально.
	part := func(i int) string {
		if i < len(parts) {
			return parts[i]
		}
		return ""
	}

	now := time.Now()
	snap := HostSnapshot{}

	cpu, errCPU := ParseStat(part(0))
	if errCPU != nil {
		snap.Missing = append(snap.Missing, "cpu")
	}
	if mem, err := ParseMeminfo(part(1)); err == nil {
		snap.Mem = mem
	} else {
		snap.Missing = append(snap.Missing, "memory")
	}
	snap.Disks = ParseDF(part(2))
	if len(snap.Disks) == 0 {
		snap.Missing = append(snap.Missing, "disk")
	}
	net, errNet := ParseNetDev(part(3))
	if errNet != nil {
		snap.Missing = append(snap.Missing, "net")
	}
	if up, err := ParseUptime(part(4)); err == nil {
		snap.Uptime = up
	} else {
		snap.Missing = append(snap.Missing, "uptime")
	}

	// Совсем пустой ответ это уже не деградация, а разрыв связи: сообщаем
	// ошибкой, чтобы тикер приглушил экран, а не рисовал пять прочерков.
	if len(snap.Missing) == 5 {
		return HostSnapshot{}, errShortOutput
	}

	if h.hasPrev {
		if errCPU == nil {
			snap.CPUPercent = CPUPercent(h.prevCPU, cpu)
		}
		if errNet == nil {
			snap.RxPerSec, snap.TxPerSec = NetRate(h.prevNet, net, now.Sub(h.prevAt).Seconds())
		}
		snap.Valid = true
	}

	if errCPU == nil {
		h.prevCPU = cpu
	}
	if errNet == nil {
		h.prevNet = net
	}
	h.prevAt, h.hasPrev = now, true
	return snap, nil
}
