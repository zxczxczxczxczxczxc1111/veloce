package collect

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func ParseUptime(out string) (time.Duration, error) {
	f := strings.Fields(out)
	if len(f) == 0 {
		return 0, fmt.Errorf("пустой вывод /proc/uptime")
	}
	sec, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, err
	}
	return time.Duration(sec * float64(time.Second)), nil
}
